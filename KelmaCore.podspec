Pod::Spec.new do |spec|
  spec.name = 'KelmaCore'
  spec.version = '0.1.0'
  spec.summary = 'React Native bridge to Kelma’s Anki-compatible Rust core'
  spec.homepage = 'https://github.com/'
  spec.license = { :type => 'AGPL-3.0-or-later', :file => 'COPYING' }
  spec.author = 'Kelma contributors'
  spec.source = { :path => '.' }
  spec.platform = :ios, '15.1'

  spec.source_files = 'ios/KelmaCore/**/*.{h,mm}'
  spec.private_header_files = 'ios/KelmaCore/**/*.h'
  spec.preserve_paths = [
    'rust/kelma-core/**/*',
    'vendor/anki/**/*',
    'scripts/build-rust-for-xcode.sh',
  ]

  spec.dependency 'React-Core'
  spec.dependency 'ReactCodegen'
  spec.frameworks = 'Security', 'SystemConfiguration'
  spec.libraries = 'c++', 'z'
  spec.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/rust/kelma-core/include"',
  }

  rust_archive = '$(PODS_CONFIGURATION_BUILD_DIR)/KelmaCore/libkelma_core.a'
  spec.user_target_xcconfig = {
    'OTHER_LDFLAGS' => "$(inherited) \"#{rust_archive}\"",
  }

  spec.script_phase = {
    :name => 'Build Anki Rust core',
    :script => '"${PODS_TARGET_SRCROOT}/scripts/build-rust-for-xcode.sh"',
    :execution_position => :before_compile,
    :input_files => [
      '${PODS_TARGET_SRCROOT}/rust/kelma-core/Cargo.toml',
      '${PODS_TARGET_SRCROOT}/rust/kelma-core/Cargo.lock',
      '${PODS_TARGET_SRCROOT}/rust/kelma-core/src/lib.rs',
    ],
    :output_files => [
      rust_archive,
    ],
  }
end
