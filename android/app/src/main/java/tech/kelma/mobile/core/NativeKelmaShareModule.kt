package tech.kelma.mobile.core

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

class NativeKelmaShareModule(
  reactContext: ReactApplicationContext,
) : NativeKelmaShareSpec(reactContext), ActivityEventListener {

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = NAME

  override fun shareFile(path: String, title: String, promise: Promise) {
    promise.resolve(false)
  }

  override fun pickFile(promise: Promise) {
    promise.resolve("")
  }

  override fun copyUriToTempPath(uri: String, promise: Promise) {
    promise.resolve("")
  }

  override fun downloadUrlToTempPath(url: String, promise: Promise) {
    promise.resolve("")
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    // No-op stub
  }

  override fun onNewIntent(intent: Intent) {
    // No-op stub
  }

  companion object {
    const val NAME = "NativeKelmaShare"
  }
}
