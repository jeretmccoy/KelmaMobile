/*
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Android adapter for the shared KelmaCore contract. iOS drives rslib through
 * the Kelma C ABI; Android drives the *same* rslib through AnkiDroid's rsdroid
 * backend. Both expose identical coarse JSON operations so the React Native
 * layer is platform-agnostic.
 *
 * The typed proto classes (anki.*) and Backend method names below come from the
 * pinned backend `0.1.64-anki25.09.2`. If the backend is advanced, regenerate
 * against the new proto and adjust here together with the iOS bridge.
 */

package com.kelmamobile.core

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.fbreact.specs.NativeKelmaCoreSpec
import net.ankiweb.rsdroid.Backend
import net.ankiweb.rsdroid.BackendFactory
import net.ankiweb.rsdroid.BuildConfig as AnkiBackendBuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.concurrent.thread

class NativeKelmaCoreModule(
  reactContext: ReactApplicationContext,
) : NativeKelmaCoreSpec(reactContext) {
  override fun getName() = NAME

  // One serial executor so all collection/scheduler/sync work is ordered and
  // never runs on the JS thread.
  private val executor = Executors.newSingleThreadExecutor()

  @Volatile
  private var backend: Backend? = null

  @Volatile
  private var collectionOpen = false

  override fun getCoreInfo(promise: Promise) {
    thread(name = "kelma-rust-core-init") {
      try {
        val language = Locale.getDefault().toLanguageTag()
        BackendFactory.getBackend(listOf(language)).use { backend ->
          check(backend.isOpen()) { "Anki Rust backend did not open" }
          val info =
            JSONObject()
              .put("ankiVersion", AnkiBackendBuildConfig.ANKI_DESKTOP_VERSION)
              .put("ankiCommit", AnkiBackendBuildConfig.ANKI_COMMIT_HASH)
              .put("bridgeVersion", BACKEND_VERSION)
              .put("platform", "android")
          promise.resolve(info.toString())
        }
      } catch (error: Throwable) {
        promise.reject("KELMA_CORE_INIT", "Unable to load the Anki Rust backend", error)
      }
    }
  }

  override fun openCollection(request: String, promise: Promise) {
    executor.execute {
      try {
        // The JS layer passes {profileId}; the native layer owns the on-device
        // filesystem layout and resolves it to concrete collection paths.
        val json = JSONObject(request)
        val profileId = json.optString("profileId", "default").ifEmpty { "default" }
        val profileDir = java.io.File(reactApplicationContext.filesDir, "kelma/$profileId")
        profileDir.mkdirs()

        val language = Locale.getDefault().toLanguageTag()
        val backend = this.backend ?: BackendFactory.getBackend(listOf(language)).also {
          this.backend = it
        }
        if (collectionOpen) {
          backend.closeCollection(false)
          collectionOpen = false
        }
        backend.openCollection(
          java.io.File(profileDir, "collection.anki2").absolutePath,
          java.io.File(profileDir, "collection.media").absolutePath,
          java.io.File(profileDir, "collection.media.db2").absolutePath,
          "",
        )
        collectionOpen = true
        promise.resolve("{\"opened\":true}")
      } catch (error: Throwable) {
        promise.reject("KELMA_OPEN", error.message ?: "Unable to open collection.", error)
      }
    }
  }


  override fun closeCollection(promise: Promise) {
    executor.execute {
      try {
        if (collectionOpen) {
          backend?.closeCollection(false)
          collectionOpen = false
        }
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("KELMA_CLOSE", error.message ?: "Unable to close collection.", error)
      }
    }
  }

  override fun runCollectionOp(op: String, request: String, promise: Promise) {
    executor.execute {
      val backend = this.backend
      if (backend == null || !collectionOpen) {
        promise.reject("KELMA_NO_SESSION", "No collection is open.")
        return@execute
      }
      try {
        val json = if (request.isEmpty()) JSONObject() else JSONObject(request)
        val result: String = when (op) {
          "deckTree" -> deckTree(backend)
          "nextCard" -> nextCard(backend)
          "answerCard" -> answerCard(backend, json)
          "syncLogin" -> syncLogin(backend, json)
          "syncCollection" -> syncCollection(backend, json)
          "syncStatus" -> syncStatus(backend)
          "fullSync" -> fullSync(backend, json)
          else -> throw IllegalArgumentException("unknown session operation '$op'")
        }
        promise.resolve(result)
      } catch (error: Throwable) {
        promise.reject("KELMA_OP", error.message ?: "Collection operation failed.", error)
      }
    }
  }

  // --- rslib-backed operations -------------------------------------------------

  private fun deckTree(backend: Backend): String {
    val node = backend.deckTree(0L) // 0 == use current time
    return deckNodeToJson(node).toString()
  }

  private fun deckNodeToJson(node: anki.decks.DeckTreeNode): JSONObject {
    val children = JSONArray()
    for (child in node.childrenList) {
      children.put(deckNodeToJson(child))
    }
    return JSONObject()
      .put("deckId", node.deckId)
      .put("name", node.name)
      .put("level", node.level)
      .put("collapsed", node.collapsed)
      .put("filtered", node.filtered)
      .put("newCount", node.newCount)
      .put("learnCount", node.learnCount)
      .put("reviewCount", node.reviewCount)
      .put("children", children)
  }

  private fun nextCard(backend: Backend): String {
    val request = anki.scheduler.GetQueuedCardsRequest.newBuilder()
      .setFetchLimit(1)
      .setIntradayLearningOnly(false)
      .build()
    val queued = backend.getQueuedCards(request)

    val counts = JSONObject()
      .put("new", queued.newCount)
      .put("learning", queued.learningCount)
      .put("review", queued.reviewCount)

    val out = JSONObject().put("counts", counts)
    if (queued.cardsCount == 0) {
      out.put("card", JSONObject.NULL)
      return out.toString()
    }

    val queuedCard = queued.getCards(0)
    val cardId = queuedCard.card.id
    val render = backend.renderExistingCard(cardId, false, false)

    out.put(
      "card",
      JSONObject()
        .put("cardId", cardId)
        .put("deckName", queuedCard.context.deckName)
        .put("question", flattenNodes(render.questionNodesList))
        .put("answer", flattenNodes(render.answerNodesList))
        .put("css", render.css),
    )
    return out.toString()
  }

  private fun flattenNodes(
    nodes: List<anki.card_rendering.RenderedTemplateNode>,
  ): String {
    val sb = StringBuilder()
    for (node in nodes) {
      if (node.hasText()) {
        sb.append(node.text)
      } else if (node.hasReplacement()) {
        sb.append(node.replacement.currentText)
      }
    }
    return sb.toString()
  }

  private fun answerCard(backend: Backend, json: JSONObject): String {
    val cardId = json.getLong("cardId")
    val rating = json.getInt("rating")
    val msTaken = json.optInt("millisecondsTaken", 0)

    val states = backend.getSchedulingStates(cardId)
    val newState = when (rating) {
      0 -> states.again
      1 -> states.hard
      2 -> states.good
      3 -> states.easy
      else -> throw IllegalArgumentException("invalid rating $rating")
    }
    val answer = anki.scheduler.CardAnswer.newBuilder()
      .setCardId(cardId)
      .setCurrentState(states.current)
      .setNewState(newState)
      .setRating(anki.scheduler.CardAnswer.Rating.forNumber(rating))
      .setAnsweredAtMillis(System.currentTimeMillis())
      .setMillisecondsTaken(msTaken)
      .build()
    backend.answerCard(answer)
    return "{\"answered\":true}"
  }

  private fun syncLogin(backend: Backend, json: JSONObject): String {
    val request = anki.sync.SyncLoginRequest.newBuilder()
      .setUsername(json.getString("username"))
      .setPassword(json.getString("password"))
      .setEndpoint(json.getString("endpoint"))
      .build()
    val auth = backend.syncLogin(request.username, request.password, request.endpoint)
    return JSONObject()
      .put("hkey", auth.hkey)
      .put("endpoint", json.getString("endpoint"))
      .toString()
  }

  private fun syncCollection(backend: Backend, json: JSONObject): String {
    val auth = anki.sync.SyncAuth.newBuilder()
      .setHkey(json.getString("hkey"))
      .setEndpoint(json.getString("endpoint"))
      .build()
    val response = backend.syncCollection(auth, false)

    // Normalize the proto enum to the strings the shared UI expects.
    val required = when (response.required) {
      anki.sync.SyncCollectionResponse.ChangesRequired.NO_CHANGES -> "noChanges"
      anki.sync.SyncCollectionResponse.ChangesRequired.NORMAL_SYNC -> "normalSyncRequired"
      else -> "fullSyncRequired"
    }
    val uploadOk =
      response.required == anki.sync.SyncCollectionResponse.ChangesRequired.FULL_UPLOAD
    val downloadOk =
      response.required == anki.sync.SyncCollectionResponse.ChangesRequired.FULL_DOWNLOAD
    return JSONObject()
      .put("required", required)
      .put("uploadOk", uploadOk || required == "fullSyncRequired")
      .put("downloadOk", downloadOk || required == "fullSyncRequired")
      .put("serverMessage", response.serverMessage)
      .put("newEndpoint", if (response.hasNewEndpoint()) response.newEndpoint else JSONObject.NULL)
      .toString()
  }

  private fun syncStatus(backend: Backend): String {
    return JSONObject().put("changes", "unknown").toString()
  }

  private fun fullSync(backend: Backend, json: JSONObject): String {
    val auth = anki.sync.SyncAuth.newBuilder()
      .setHkey(json.getString("hkey"))
      .setEndpoint(json.getString("endpoint"))
      .build()
    val upload = json.getBoolean("upload")
    backend.fullUploadOrDownload(auth, upload, null)
    return JSONObject().put("completed", true).put("upload", upload).toString()
  }

  companion object {
    const val NAME = "NativeKelmaCore"
    const val BACKEND_VERSION = "0.1.64-anki25.09.2"
  }
}
