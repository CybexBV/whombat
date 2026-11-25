package com.whombat.updater

import android.app.job.JobParameters
import android.app.job.JobService

/** Android's periodic run of `UpdateWatch.check`, on a thread of its own (a job starts on the main thread). */
class UpdateCheckJob : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    Thread {
      runCatching { UpdateWatch.check(applicationContext) }
      jobFinished(params, false)
    }.start()
    return true
  }

  /** A check cut short is simply asked again at the next run. */
  override fun onStopJob(params: JobParameters): Boolean = false
}
