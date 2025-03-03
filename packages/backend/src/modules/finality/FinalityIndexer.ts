import { Logger } from '@l2beat/backend-tools'
import { UnixTime } from '@l2beat/shared-pure'
import { ChildIndexer, Retries } from '@l2beat/uif'
import { mean } from 'lodash'

import { IndexerStateRepository } from '../../peripherals/database/repositories/IndexerStateRepository'
import { LivenessIndexer } from '../liveness/LivenessIndexer'
import {
  FinalityRecord,
  FinalityRepository,
} from './repositories/FinalityRepository'
import { FinalityConfig } from './types/FinalityConfig'

/*
  Once per day we want to fetch finality data for each project for last 24h, with granularity of 10 minutes,
  so in every hour there will be 6 calls
*/
const FINALITY_GRANULARITY = 24 * 6

const UPDATE_RETRY_STRATEGY = Retries.exponentialBackOff({
  maxAttempts: 10,
  initialTimeoutMs: 1000,
})

export class FinalityIndexer extends ChildIndexer {
  readonly indexerId

  constructor(
    logger: Logger,
    parentIndexer: LivenessIndexer,
    private readonly stateRepository: IndexerStateRepository,
    private readonly finalityRepository: FinalityRepository,
    private readonly configuration: FinalityConfig,
  ) {
    super(logger.tag(configuration.projectId.toString()), [parentIndexer], {
      updateRetryStrategy: UPDATE_RETRY_STRATEGY,
    })
    this.indexerId = `finality_indexer_${configuration.projectId.toString()}`
  }

  override async start(): Promise<void> {
    this.logger.info('Starting...')
    await this.initialize()
    await super.start()
  }

  override async update(from: number, to: number): Promise<number> {
    const targetTimestamp = new UnixTime(to).toStartOf('day')

    if (to < this.configuration.minTimestamp.toNumber()) {
      this.logger.debug('Update skipped: target earlier than minimumTimestamp')
      return to
    }

    const isSynced = await this.isConfigurationSynced(targetTimestamp)
    if (isSynced) {
      this.logger.debug('Update skipped: configuration already synced', {
        from,
        to,
        targetTimestamp,
      })
      return to
    }

    const finalityData = await this.getFinalityData(
      targetTimestamp,
      this.configuration,
    )

    if (finalityData) {
      await this.finalityRepository.add(finalityData)
    }

    this.logger.info('Update finished', {
      from,
      to,
      targetTimestamp,
      finalityData,
    })

    return to
  }

  async isConfigurationSynced(targetTimestamp: UnixTime) {
    const latestSynced = await this.finalityRepository.findLatestByProjectId(
      this.configuration.projectId,
    )

    return !!latestSynced?.timestamp.gte(targetTimestamp)
  }

  async getFinalityData(
    to: UnixTime,
    configuration: FinalityConfig,
  ): Promise<FinalityRecord | undefined> {
    const from = to.add(-1, 'days')

    const projectFinalityTimestamps =
      await configuration.analyzer.getFinalityWithGranularity(
        from,
        to,
        FINALITY_GRANULARITY,
      )

    if (!projectFinalityTimestamps) return

    return {
      projectId: configuration.projectId,
      timestamp: to,
      minimumTimeToInclusion: Math.min(...projectFinalityTimestamps),
      maximumTimeToInclusion: Math.max(...projectFinalityTimestamps),
      averageTimeToInclusion: Math.round(mean(projectFinalityTimestamps)),
    }
  }

  private async initialize() {
    await this.initializeIndexerState()
  }

  async initializeIndexerState() {
    const safeHeight = this.configuration.minTimestamp.toNumber()
    const indexerState = await this.stateRepository.findIndexerState(
      this.indexerId,
    )

    if (indexerState === undefined) {
      await this.stateRepository.add({
        indexerId: this.indexerId,
        safeHeight,
        minTimestamp: this.configuration.minTimestamp,
      })
      return
    }

    await this.setSafeHeight(safeHeight)
  }

  override async getSafeHeight(): Promise<number> {
    const indexerState = await this.stateRepository.findIndexerState(
      this.indexerId,
    )
    return (
      indexerState?.safeHeight ?? this.configuration.minTimestamp.toNumber()
    )
  }

  override async setSafeHeight(safeHeight: number): Promise<void> {
    await this.stateRepository.setSafeHeight(this.indexerId, safeHeight)
  }

  /**
   * WARNING: this method does not do anything
   *
    In our case there is no re-org handling so we do not have to worry
    that our data will become invalid.
    Also there is no need to handle the case when the server is randomly shut down during update,
    liveness configurations are storing the latest synced timestamp, so even if the server is shut down
    without setting new safeHeight. And although the next update will run on the already processed timestamp,
    the configuration's lastSyncedTimestamp will filter out already processed configurations
    and the data will not be fetched again
  **/
  override async invalidate(targetHeight: number): Promise<number> {
    return Promise.resolve(targetHeight)
  }
}
