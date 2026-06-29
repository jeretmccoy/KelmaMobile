/*
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

#import "RCTNativeKelmaCore.h"

#import "kelma_core.h"

@implementation RCTNativeKelmaCore {
  // One long-lived collection session, owned by the Rust core. All access is
  // serialized on `_coreQueue` so SQLite/scheduler work never races and never
  // blocks the JS thread.
  void *_session;
  dispatch_queue_t _coreQueue;
}

RCT_EXPORT_MODULE(NativeKelmaCore)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    _session = nullptr;
    _coreQueue = dispatch_queue_create("app.kelma.core", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)dealloc
{
  if (_session != nullptr) {
    kelma_session_close(_session);
    _session = nullptr;
  }
}

#pragma mark - Helpers

static NSString *KelmaStringFromBuffer(KelmaBuffer buffer)
{
  NSData *data = buffer.data == nullptr
    ? [NSData data]
    : [NSData dataWithBytes:buffer.data length:buffer.len];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
}

// Resolves the on-device collection paths for a profile, creating the profile
// directory if needed, and returns the JSON request expected by the Rust core.
// The collection lives under Application Support so iOS excludes it from
// user-visible storage while keeping it backed up.
static NSString *KelmaOpenRequestForProfile(NSString *profileId, NSError **error)
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSURL *support = [fm URLForDirectory:NSApplicationSupportDirectory
                              inDomain:NSUserDomainMask
                     appropriateForURL:nil
                                create:YES
                                 error:error];
  if (support == nil) {
    return nil;
  }

  NSURL *profileDir = [[support URLByAppendingPathComponent:@"kelma" isDirectory:YES]
      URLByAppendingPathComponent:profileId.length > 0 ? profileId : @"default"
                      isDirectory:YES];
  if (![fm createDirectoryAtURL:profileDir
      withIntermediateDirectories:YES
                       attributes:nil
                            error:error]) {
    return nil;
  }

  NSDictionary *request = @{
    @"collectionPath": [profileDir URLByAppendingPathComponent:@"collection.anki2"].path,
    @"mediaFolderPath": [profileDir URLByAppendingPathComponent:@"collection.media"].path,
    @"mediaDbPath": [profileDir URLByAppendingPathComponent:@"collection.media.db2"].path,
  };
  NSData *json = [NSJSONSerialization dataWithJSONObject:request options:0 error:error];
  if (json == nil) {
    return nil;
  }
  return [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
}


#pragma mark - Core identity

- (void)getCoreInfo:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_coreQueue, ^{
    KelmaResult result = kelma_core_info();
    NSString *payload = KelmaStringFromBuffer(result.payload);
    kelma_buffer_free(result.payload);

    if (result.status == 0) {
      resolve(payload);
    } else {
      reject(@"KELMA_CORE_INIT",
             payload.length > 0 ? payload : @"The Anki Rust core returned invalid data.",
             nil);
    }
  });
}

#pragma mark - Collection session

- (void)openCollection:(NSString *)request
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_coreQueue, ^{
    if (self->_session != nullptr) {
      kelma_session_close(self->_session);
      self->_session = nullptr;
    }

    // The JS layer passes {profileId}; the native layer owns the filesystem
    // layout and turns it into concrete collection paths.
    NSError *parseError = nil;
    NSData *requestData = [request dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    NSDictionary *requestJson =
        [NSJSONSerialization JSONObjectWithData:requestData options:0 error:&parseError];
    NSString *profileId = [requestJson isKindOfClass:[NSDictionary class]]
        ? (requestJson[@"profileId"] ?: @"default")
        : @"default";

    NSError *pathError = nil;
    NSString *openRequest = KelmaOpenRequestForProfile(profileId, &pathError);
    if (openRequest == nil) {
      reject(@"KELMA_OPEN",
             pathError.localizedDescription ?: @"Unable to resolve the collection path.",
             pathError);
      return;
    }

    NSData *input = [openRequest dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    KelmaSessionResult result =
        kelma_session_open((const uint8_t *)input.bytes, input.length);


    if (result.status == 0 && result.handle != nullptr) {
      self->_session = result.handle;
      kelma_buffer_free(result.error);
      resolve(@"{\"opened\":true}");
    } else {
      NSString *message = KelmaStringFromBuffer(result.error);
      kelma_buffer_free(result.error);
      reject(@"KELMA_OPEN", message.length > 0 ? message : @"Unable to open collection.", nil);
    }
  });
}

- (void)closeCollection:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_coreQueue, ^{
    if (self->_session != nullptr) {
      kelma_session_close(self->_session);
      self->_session = nullptr;
    }
    resolve(nil);
  });
}

- (void)runCollectionOp:(NSString *)op
                request:(NSString *)request
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(_coreQueue, ^{
    if (self->_session == nullptr) {
      reject(@"KELMA_NO_SESSION", @"No collection is open.", nil);
      return;
    }

    NSData *input = [request dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    KelmaResult result = kelma_session_run(
        self->_session,
        op.UTF8String,
        (const uint8_t *)input.bytes,
        input.length);

    NSString *payload = KelmaStringFromBuffer(result.payload);
    kelma_buffer_free(result.payload);

    if (result.status == 0) {
      resolve(payload);
    } else {
      reject(@"KELMA_OP", payload.length > 0 ? payload : @"Collection operation failed.", nil);
    }
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeKelmaCoreSpecJSI>(params);
}

@end
