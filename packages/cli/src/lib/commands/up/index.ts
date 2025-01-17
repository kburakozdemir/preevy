import fs from 'fs'
import yaml from 'yaml'
import path from 'path'
import { rimraf } from 'rimraf'
import { formatPublicKey } from '@preevy/common'
import { Logger } from '../../../log'
import { Machine, MachineDriver } from '../../machine'
import { FileToCopy } from '../../ssh/client'
import { SSHKeyConfig } from '../../ssh/keypair'
import { fixModelForRemote } from '../../compose/model'
import { TunnelOpts } from '../../ssh/url'
import { ensureCustomizedMachine } from './machine'
import { wrapWithDockerSocket } from './docker'
import { localComposeClient } from '../../compose/client'
import { Tunnel } from '../../tunneling'
import { findAmbientEnvId } from '../../env-id'
import { COMPOSE_TUNNEL_AGENT_SERVICE_NAME, addComposeTunnelAgentService, composeTunnelAgentSocket, queryTunnels } from '../../compose-tunnel-agent-client'
import { copyFilesWithoutRecreatingDirUsingSftp } from '../../sftp-copy'
import { withSpinner } from '../../spinner'
import { ProcessError, orderedOutput } from '../../child-process'
import { MachineCreationDriver } from '../../machine/driver/driver'
import { REMOTE_DIR_BASE, remoteProjectDir } from '../../remote-files'

const createCopiedFileInDataDir = (
  { projectLocalDataDir, filesToCopy, remoteDir } : {
    projectLocalDataDir: string
    filesToCopy: FileToCopy[]
    remoteDir: string
  }
) => async (
  filename: string,
  content: string | Buffer
): Promise<{ local: string; remote: string }> => {
  const local = path.join(projectLocalDataDir, filename)
  await fs.promises.mkdir(path.dirname(local), { recursive: true })
  await fs.promises.writeFile(local, content, { flag: 'w' })
  filesToCopy.push({ local, remote: filename })
  return { local, remote: path.join(remoteDir, filename) }
}

const calcComposeArgs = (userSpecifiedServices: string[], debug: boolean) => {
  const upServices = userSpecifiedServices.length
    ? userSpecifiedServices.concat(COMPOSE_TUNNEL_AGENT_SERVICE_NAME)
    : []

  return [
    ...debug ? ['--verbose'] : [],
    'up', '-d', '--remove-orphans', '--build',
    ...upServices,
  ]
}

const up = async ({
  debug,
  machineDriver,
  machineCreationDriver,
  tunnelOpts,
  userSpecifiedProjectName,
  userSpecifiedEnvId,
  userSpecifiedServices,
  log,
  composeFiles: userComposeFiles,
  dataDir,
  sshKey,
  allowedSshHostKeys: hostKey,
  sshTunnelPrivateKey,
}: {
  debug: boolean
  machineDriver: MachineDriver
  machineCreationDriver: MachineCreationDriver
  tunnelOpts: TunnelOpts
  userSpecifiedProjectName: string | undefined
  userSpecifiedEnvId: string | undefined
  userSpecifiedServices: string[]
  log: Logger
  composeFiles: string[]
  dataDir: string
  sshKey: SSHKeyConfig
  sshTunnelPrivateKey: string
  allowedSshHostKeys: Buffer
}): Promise<{ machine: Machine; tunnels: Tunnel[]; envId: string }> => {
  log.debug('Normalizing compose files')

  const userModel = await localComposeClient(userComposeFiles, userSpecifiedProjectName).getModel().catch(e => {
    if (!(e instanceof ProcessError)) {
      throw e
    }
    const details = e.output
      ? orderedOutput(e.output).stderr().toString('utf-8').trim()
      : e.toString()
    throw new Error(`docker compose: ${details}`, { cause: e })
  })
  const projectName = userSpecifiedProjectName ?? userModel.name
  const remoteDir = remoteProjectDir(projectName)
  const { model: fixedModel, filesToCopy } = await fixModelForRemote({ remoteDir }, userModel)

  const projectLocalDataDir = path.join(dataDir, projectName)
  await rimraf(projectLocalDataDir)

  const createCopiedFile = createCopiedFileInDataDir({ projectLocalDataDir, filesToCopy, remoteDir })
  const [sshPrivateKeyFile, knownServerPublicKey] = await Promise.all([
    createCopiedFile('tunnel_client_private_key', sshTunnelPrivateKey),
    createCopiedFile('tunnel_server_public_key', formatPublicKey(hostKey)),
  ])

  const envId = userSpecifiedEnvId || await findAmbientEnvId(projectName)

  log.info(`Using environment ID: ${envId}`)

  const { machine, sshClient } = await ensureCustomizedMachine({
    machineDriver, machineCreationDriver, sshKey, envId, log, debug,
  })

  const composeTunnelAgentUser = (
    await sshClient.execCommand('echo "$(id -u):$(stat -c %g /var/run/docker.sock)"')
  ).stdout.trim()

  const remoteModel = addComposeTunnelAgentService({
    debug,
    tunnelOpts,
    urlSuffix: envId,
    sshPrivateKeyPath: sshPrivateKeyFile.remote,
    knownServerPublicKeyPath: knownServerPublicKey.remote,
    listenAddress: composeTunnelAgentSocket(projectName),
    user: composeTunnelAgentUser,
  }, fixedModel)

  log.debug('model', yaml.stringify(remoteModel))

  const composeFilePath = (await createCopiedFile('docker-compose.yml', yaml.stringify(remoteModel))).local

  const withDockerSocket = wrapWithDockerSocket({ sshClient, log })

  try {
    await sshClient.execCommand(`sudo mkdir -p "${remoteDir}" && sudo chown $USER "${remoteDir}"`)

    log.debug('Files to copy', filesToCopy)

    await copyFilesWithoutRecreatingDirUsingSftp(sshClient, REMOTE_DIR_BASE, remoteDir, filesToCopy)

    const compose = localComposeClient([composeFilePath], projectName)
    const composeArgs = calcComposeArgs(userSpecifiedServices, debug)
    log.debug('Running compose up with args: ', composeArgs)
    await withDockerSocket(() => compose.spawnPromise(composeArgs, { stdio: 'inherit' }))

    const tunnels = await withSpinner(async () => {
      const queryResult = await queryTunnels({
        sshClient, projectName, retryOpts: { minTimeout: 1000, maxTimeout: 2000, retries: 10 },
      })

      return queryResult.tunnels
    }, { opPrefix: 'Waiting for tunnels to be created' })

    return { envId, machine, tunnels }
  } finally {
    sshClient.dispose()
  }
}

export default up
