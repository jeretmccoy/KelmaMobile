/*
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

package com.kelmamobile.core

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeKelmaCorePackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? =
    if (name == NativeKelmaCoreModule.NAME) {
      NativeKelmaCoreModule(reactContext)
    } else {
      null
    }

  override fun getReactModuleInfoProvider() =
    ReactModuleInfoProvider {
      mapOf(
        NativeKelmaCoreModule.NAME to
          ReactModuleInfo(
            name = NativeKelmaCoreModule.NAME,
            className = NativeKelmaCoreModule.NAME,
            canOverrideExistingModule = false,
            needsEagerInit = false,
            isCxxModule = false,
            isTurboModule = true,
          ),
      )
    }
}
