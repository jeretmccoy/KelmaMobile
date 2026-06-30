# iOS build — `react-native-sound` link fix

## The error

Building for the iOS simulator fails at link time with:

```
Undefined symbols for architecture arm64:
  "_AVAudioSessionCategoryAmbient", referenced from:
      -[RNSound enable:] in libRNSound.a(...)(RNSound.o)
  "_OBJC_CLASS_$_AVAudioSession", referenced from:
      in libRNSound.a(...)(RNSound.o)
ld: symbol(s) not found for architecture arm64
```

## Cause

`react-native-sound@0.13`'s podspec (`node_modules/react-native-sound/RNSound.podspec`)
does not declare the system frameworks its Objective-C code links against.
`RNSound` uses `AVAudioSession` (from `AVFoundation`), but that framework is
never added to the link line, so the symbols are missing at link time.

## The permanent fix

Kelma declares `AVFoundation` and `AudioToolbox` in its checked-in
`KelmaCore.podspec`. CocoaPods propagates those frameworks to the app link
line:

```ruby
spec.frameworks = 'AVFoundation', 'AudioToolbox', 'Security', 'SystemConfiguration'
```

After changing native dependencies, regenerate Pods and rebuild:

```bash
cd ios
bundle exec pod install
cd ..
npm run ios
```

This survives `npm install` because it does not modify `node_modules`.

## How to verify it worked

`AVFoundation` should appear in the generated aggregate link line:

```bash
grep AVFoundation ios/Pods/Target\ Support\ Files/Pods-KelmaMobile/Pods-KelmaMobile.debug.xcconfig
```

You should see `-framework "AVFoundation"` in the output.
