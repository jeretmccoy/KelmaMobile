package com.kelmamobile.core

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

class NativeKelmaCoreModule(
  reactContext: ReactApplicationContext,
) : NativeKelmaCoreSpec(reactContext) {
  override fun getName(): String = NAME

  override fun getCoreInfo(promise: Promise) {
    promise.resolve("""{"ankiVersion":"stub","ankiCommit":"android-emulator","bridgeVersion":"android-stub","platform":"android"}""")
  }

  override fun openCollection(request: String, promise: Promise) {
    promise.resolve("""{"ok":true}""")
  }

  override fun closeCollection(promise: Promise) {
    promise.resolve(null)
  }

  override fun runCollectionOp(op: String, request: String, promise: Promise) {
    val result = when (op) {
      "deckTree" -> """
        {
          "deckId":1,
          "name":"Kelma Android Emulator",
          "level":0,
          "collapsed":false,
          "filtered":false,
          "newCount":0,
          "learnCount":0,
          "reviewCount":0,
          "children":[]
        }
      """.trimIndent()

      "mediaDir" -> """{"dir":""}"""

      "stats" -> """
        {
          "studiedToday":"Android emulator stub build is running.",
          "counts":{"total":0,"new":0,"learning":0,"young":0,"mature":0,"suspended":0}
        }
      """.trimIndent()

      "deckOverview" -> """
        {
          "deckName":"Kelma Android Emulator",
          "counts":{"new":0,"learning":0,"review":0},
          "description":"Android emulator smoke-test build."
        }
      """.trimIndent()

      "nextCard" -> """{"counts":{"new":0,"learning":0,"review":0},"card":null}"""
      "browseDeck" -> """{"cards":[]}"""
      "pendingChanges" -> """{"hasChanges":false,"lastSyncMs":0,"decks":[]}"""
      "getSyncAuth" -> "null"
      "syncStatus" -> """{"status":"idle","message":"Android emulator stub"}"""
      "syncDebug" -> """{"col":{"mod":0,"scm":0,"ls":0,"usn":0},"pendingCards":0,"pendingNotes":0,"pendingRevlogs":0,"pendingGraves":0,"totalCards":0,"totalRevlogs":0}"""
      "setDeck", "answerCard", "setSyncAuth", "clearSyncAuth", "syncLogin", "syncCollection", "syncMedia", "fullSync", "writeCardHtml" -> "{}"
      else -> "{}"
    }

    promise.resolve(result)
  }

  companion object {
    const val NAME = "NativeKelmaCore"
  }
}
