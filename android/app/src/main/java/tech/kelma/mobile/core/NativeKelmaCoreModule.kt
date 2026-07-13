/*
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Android adapter for the shared Kelma Rust session. The platform layer owns
 * paths, lifecycle, threading, and JSON/string conversion only; collection,
 * scheduling, rendering, imports/exports, and KelmaSync v2 stay in Rust.
 */

package tech.kelma.mobile.core

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class NativeKelmaCoreModule(
  reactContext: ReactApplicationContext,
) : NativeKelmaCoreSpec(reactContext) {
  override fun getName(): String = NAME

  // One long-lived Rust session. Every access is ordered on this executor so
  // SQLite/scheduler operations never race and never block the JS thread.
  private val executor = Executors.newSingleThreadExecutor()
  private var session: Long = 0

  override fun getCoreInfo(promise: Promise) {
    executor.execute {
      try {
        promise.resolve(KelmaCoreJni.coreInfo())
      } catch (error: Throwable) {
        promise.reject("KELMA_CORE_INIT", error.message ?: "Unable to load the Anki Rust backend", error)
      }
    }
  }

  override fun openCollection(request: String, promise: Promise) {
    executor.execute {
      try {
        closeSession()

        // JS supplies only profile identity and timezone. Native code owns the
        // application-private filesystem layout and sends concrete paths to Rust.
        val input = JSONObject(request)
        val profileId = input.optString("profileId", "default").ifEmpty { "default" }
        val profileDir = File(reactApplicationContext.filesDir, "kelma/$profileId")
        check(profileDir.mkdirs() || profileDir.isDirectory) {
          "Unable to create profile directory ${profileDir.absolutePath}"
        }
        val mediaDir = File(profileDir, "collection.media")
        check(mediaDir.mkdirs() || mediaDir.isDirectory) {
          "Unable to create media directory ${mediaDir.absolutePath}"
        }

        val openRequest = JSONObject()
          .put("collectionPath", File(profileDir, "collection.anki2").absolutePath)
          .put("mediaFolderPath", mediaDir.absolutePath)
          .put("mediaDbPath", File(profileDir, "collection.media.db2").absolutePath)
        input.optString("timeZone").takeIf(String::isNotEmpty)?.let {
          openRequest.put("timeZone", it)
        }

        session = KelmaCoreJni.open(openRequest.toString())
        check(session != 0L) { "The native core did not return a collection session." }
        promise.resolve("{\"opened\":true}")
      } catch (error: Throwable) {
        session = 0
        promise.reject("KELMA_OPEN", error.message ?: "Unable to open collection.", error)
      }
    }
  }

  override fun closeCollection(promise: Promise) {
    executor.execute {
      try {
        closeSession()
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("KELMA_CLOSE", error.message ?: "Unable to close collection.", error)
      }
    }
  }

  override fun runCollectionOp(op: String, request: String, promise: Promise) {
    executor.execute {
      if (session == 0L) {
        promise.reject("KELMA_NO_SESSION", "No collection is open.")
        return@execute
      }
      try {
        promise.resolve(KelmaCoreJni.run(session, op, request))
      } catch (error: Throwable) {
        promise.reject("KELMA_OP", error.message ?: "Collection operation failed.", error)
      }
    }
  }

  override fun invalidate() {
    executor.execute { runCatching { closeSession() } }
    executor.shutdown()
    super.invalidate()
  }

  private fun closeSession() {
    if (session != 0L) {
      KelmaCoreJni.close(session)
      session = 0
    }
  }

  companion object {
    const val NAME = "NativeKelmaCore"
  }
}
