import { Command, Flags, Interfaces } from '@oclif/core'
import chalk from 'chalk'
import BaseCommand from './base-command'
import { Profile } from './lib/profile'
import { Store } from './lib/store'
import { telemetryEmitter } from './lib/telemetry'
import { fsTypeFromUrl } from './lib/store/fs'

// eslint-disable-next-line no-use-before-define
export type Flags<T extends typeof Command> = Interfaces.InferredFlags<typeof ProfileCommand['baseFlags'] & T['flags']>
export type Args<T extends typeof Command> = Interfaces.InferredArgs<T['args']>

export const onProfileChange = (profile: Profile, alias: string, location: string) => {
  telemetryEmitter().identify(profile.id, {
    profile_driver: profile.driver,
    profile_id: profile.id,
    name: profile.id,
    profile_store_type: fsTypeFromUrl(location),
  })
}

abstract class ProfileCommand<T extends typeof Command> extends BaseCommand<T> {
  static baseFlags = {
    ...BaseCommand.baseFlags,
  }

  protected flags!: Flags<T>
  protected args!: Args<T>

  public async init(): Promise<void> {
    await super.init()
    const { profileConfig } = this
    const currentProfile = await profileConfig.current()
    const currentProfileInfo = currentProfile && await profileConfig.get(currentProfile.alias)
    if (currentProfileInfo) {
      this.#profile = currentProfileInfo.info
      this.#store = currentProfileInfo.store
      onProfileChange(currentProfileInfo.info, currentProfile.alias, currentProfile.location)
    }
  }

  #store: Store | undefined
  get store(): Store {
    if (!this.#store) {
      throw new Error('Store was not initialized')
    }
    return this.#store
  }

  #profile: Profile | undefined
  get profile(): Profile {
    if (!this.#profile) {
      throw new Error(`Profile not initialized, run ${chalk.italic.bold.greenBright('preevy init')} to get started.`)
    }
    return this.#profile
  }
}

export default ProfileCommand
