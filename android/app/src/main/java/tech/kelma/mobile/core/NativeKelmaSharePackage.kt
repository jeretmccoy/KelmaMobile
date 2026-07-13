/*
 * Kelma Mobile
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

package tech.kelma.mobile.core

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeKelmaSharePackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? =
    if (name == NativeKelmaShareModule.NAME) {
      NativeKelmaShareModule(reactContext)
    } else {
      null
    }

  override fun getReactModuleInfoProvider() =
    ReactModuleInfoProvider {
      mapOf(
        NativeKelmaShareModule.NAME to
          ReactModuleInfo(
            name = NativeKelmaShareModule.NAME,
            className = NativeKelmaShareModule.NAME,
            canOverrideExistingModule = false,
            needsEagerInit = false,
            isCxxModule = false,
            isTurboModule = true,
          ),
      )
    }
}
