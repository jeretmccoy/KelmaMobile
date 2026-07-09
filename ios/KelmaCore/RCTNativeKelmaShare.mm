/*
 * Native file sharing + picking for Kelma Mobile.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Three responsibilities:
 *   - shareFile: open a UIActivityViewController for a file path (export share).
 *   - pickFile: open a UIDocumentPickerViewController for `.apkg` packages and
 *     copy the selection into NSTemporaryDirectory so rslib can open it by path
 *     (security-scoped resources can't be handed to rslib directly).
 *   - copyUriToTempPath: copy a `file://` URL the app was opened with (e.g. an
 *     `.apkg` received via the share sheet / "Open In") into NSTemporaryDirectory.
 *
 * UI work must happen on the main queue, so the module opts into main-queue
 * setup and dispatches presentation there.
 */

#import "RCTNativeKelmaShare.h"

#import <UIKit/UIKit.h>
#import <React/RCTLog.h>
#import <React/RCTUtils.h>

/// The UTI this app declares for `.apkg` packages (see Info.plist
/// UTImportedTypeDeclarations). Used to scope the document picker.
static NSString *const KelmaApkgUTI = @"com.anki.apkg";

// UIDocumentPickerDelegate is declared on a class extension so the delegate
// assignment type-checks without polluting the public header.
@interface RCTNativeKelmaShare () <UIDocumentPickerDelegate>
@end

@implementation RCTNativeKelmaShare {
  // One outstanding picker promise at a time: the document picker is modal.
  RCTPromiseResolveBlock _pickResolve;
  RCTPromiseRejectBlock _pickReject;
}

RCT_EXPORT_MODULE(NativeKelmaShare)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

#pragma mark - Share

- (void)shareFile:(NSString *)path
            title:(NSString *)title
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_main_queue(), ^{
    NSURL *url = [NSURL fileURLWithPath:path];
    if (url == nil || ![[NSFileManager defaultManager] fileExistsAtPath:path]) {
      reject(@"KELMA_SHARE_FILE", @"The file to share does not exist.", nil);
      return;
    }

    UIActivityViewController *activity =
        [[UIActivityViewController alloc] initWithActivityItems:@[ url ]
                                          applicationActivities:nil];
    if (activity == nil) {
      reject(@"KELMA_SHARE_FILE", @"Could not create a share sheet.", nil);
      return;
    }
    if (title.length > 0) {
      activity.title = title;
    }

    UIViewController *presenter = RCTPresentedViewController() ?: RCTKeyWindow().rootViewController;
    if (presenter == nil) {
      reject(@"KELMA_SHARE_FILE", @"No view controller to present the share sheet from.", nil);
      return;
    }

    // iPad requires a popoverPresentationController to avoid crashing on
    // modal presentation of a UIActivityViewController.
    if (activity.popoverPresentationController != nil) {
      activity.popoverPresentationController.sourceView = presenter.view;
      activity.popoverPresentationController.sourceRect =
          CGRectMake(presenter.view.bounds.size.width / 2.0,
                      presenter.view.bounds.size.height / 2.0,
                      1.0, 1.0);
      activity.popoverPresentationController.permittedArrowDirections = 0;
    }

    __block BOOL resolved = NO;
    activity.completionWithItemsHandler =
        ^(UIActivityType __unused activityType, BOOL completed,
          NSArray __unused *returnedItems, NSError __unused *error) {
          if (resolved) {
            return;
          }
          resolved = YES;
          resolve(@(completed));
        };

    [presenter presentViewController:activity animated:YES completion:nil];
  });
}

#pragma mark - Pick file

/// UTI strings the document picker offers. Always includes the declared
/// `.apkg` UTI plus zip/archive + generic data as fallbacks so `.apkg` files
/// (which are zip archives) are always selectable, even if the system hasn't
/// registered the custom UTI yet.
+ (NSArray<NSString *> *)apkgContentTypes
{
  // De-duplicate while preserving order.
  NSArray<NSString *> *raw = @[
    KelmaApkgUTI,
    @"public.zip-archive",
    @"public.data",
  ];
  return [[NSOrderedSet orderedSetWithArray:raw].array copy];
}

- (void)pickFile:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_pickResolve != nil) {
      // A previous picker is still open; refuse to stack.
      reject(@"KELMA_PICK_BUSY", @"A file picker is already open.", nil);
      return;
    }

    UIViewController *presenter = RCTPresentedViewController() ?: RCTKeyWindow().rootViewController;
    if (presenter == nil) {
      reject(@"KELMA_PICK_FILE", @"No view controller to present the picker from.", nil);
      return;
    }

    // initWithDocumentTypes:inMode: takes plain UTI strings and an explicit
    // import mode, avoiding the UniformTypeIdentifiers/UTType dependency and
    // the asCopy: selector that isn't visible in this SDK. Import mode copies
    // the selected file into the app container automatically.
    NSArray<NSString *> *types = [RCTNativeKelmaShare apkgContentTypes];
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initWithDocumentTypes:types
                                                              inMode:UIDocumentPickerModeImport];
    picker.delegate = self;
    picker.allowsMultipleSelection = NO;

    self->_pickResolve = resolve;
    self->_pickReject = reject;
    [presenter presentViewController:picker animated:YES completion:nil];
  });
}

#pragma mark UIDocumentPickerDelegate

- (void)documentPicker:(UIDocumentPickerViewController *)__unused controller
didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  RCTPromiseResolveBlock resolve = self->_pickResolve;
  self->_pickResolve = nil;
  self->_pickReject = nil;
  if (resolve == nil) {
    return;
  }

  NSURL *url = urls.firstObject;
  if (url == nil) {
    resolve(@"");
    return;
  }

  // Import mode already hands us a copied file, but the URL may still be
  // security-scoped on some iOS versions; copy again into a stable temp path
  // we fully own so rslib can open it without scoping.
  NSString *path = [self copyURLToTempFile:url error:nil];
  resolve(path ?: @"");
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)__unused controller
{
  RCTPromiseResolveBlock resolve = self->_pickResolve;
  self->_pickResolve = nil;
  self->_pickReject = nil;
  if (resolve != nil) {
    // Empty string = user cancelled; JS treats falsy as no selection.
    resolve(@"");
  }
}

#pragma mark - Copy URI to temp

- (void)copyUriToTempPath:(NSString *)uriString
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  NSURL *url = [NSURL URLWithString:uriString];
  // A bare path (no scheme) is also accepted: wrap it as a file URL.
  if (url == nil || ![url isFileURL]) {
    url = [NSURL fileURLWithPath:uriString];
  }
  if (url == nil || ![url isFileURL]) {
    reject(@"KELMA_COPY_URI", @"Expected a file:// URL.", nil);
    return;
  }

  NSError *error = nil;
  NSString *path = [self copyURLToTempFile:url error:&error];
  if (path == nil) {
    reject(@"KELMA_COPY_URI",
           error.localizedDescription ?: @"Could not copy the file.",
           error);
    return;
  }
  resolve(path);
}

/// Copy a (possibly security-scoped) file URL into NSTemporaryDirectory under a
/// unique `.apkg` name. Returns the path, or nil on failure. `startAccessing
/// SecurityScopedResource` is required for URLs handed to the app by other
/// processes (Files, Mail, AirDrop) and is a no-op for plain file URLs.
- (NSString *)copyURLToTempFile:(NSURL *)url error:(NSError **)error
{
  BOOL scoped = [url startAccessingSecurityScopedResource];
  @try {
    NSString *name = url.lastPathComponent ?: @"import.apkg";
    if (![name.pathExtension.lowercaseString isEqualToString:@"apkg"]) {
      name = [name stringByAppendingString:@".apkg"];
    }
    NSString *dest =
        [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"kelma-%@-%@",
                name, [NSUUID UUID].UUIDString]];
    NSURL *destURL = [NSURL fileURLWithPath:dest];

    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm copyItemAtURL:url toURL:destURL error:error]) {
      return nil;
    }
    return dest;
  } @finally {
    if (scoped) {
      [url stopAccessingSecurityScopedResource];
    }
  }
}

#pragma mark - Download URL to temp

- (void)downloadUrlToTempPath:(NSString *)urlString
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  NSURL *url = [NSURL URLWithString:urlString];
  NSString *scheme = url.scheme.lowercaseString;
  if (url == nil || (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"])) {
    reject(@"KELMA_DOWNLOAD", @"Expected an http(s) URL.", nil);
    return;
  }

  // A download task hands us a temp file URL in its completion handler; we
  // move it into NSTemporaryDirectory under a stable name. Runs on a
  // background queue (NSURLSession default), and RCTPromise is thread-safe.
  NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
  config.timeoutIntervalForRequest = 60;
  config.timeoutIntervalForResource = 600;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:config];
  NSURLSessionDownloadTask *task =
      [session downloadTaskWithURL:url
                 completionHandler:^(NSURL *location,
                                     NSURLResponse *response,
                                     NSError *error) {
    if (error != nil) {
      reject(@"KELMA_DOWNLOAD",
             error.localizedDescription ?: @"Could not download the file.",
             error);
      return;
    }
    NSHTTPURLResponse *http =
        [response isKindOfClass:[NSHTTPURLResponse class]]
            ? (NSHTTPURLResponse *)response
            : nil;
    if (http != nil && http.statusCode >= 400) {
      reject(@"KELMA_DOWNLOAD",
             [NSString stringWithFormat:@"Server returned status %ld.",
                 (long)http.statusCode],
             nil);
      return;
    }

    // Prefer the response's suggested filename, then the URL's last path
    // component, defaulting to "import.apkg".
    NSString *name = [response suggestedFilename]
        ?: url.lastPathComponent;
    if (name.length == 0) {
      name = @"import.apkg";
    }
    if (![name.pathExtension.lowercaseString isEqualToString:@"apkg"]) {
      name = [name stringByAppendingString:@".apkg"];
    }

    NSString *dest =
        [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"kelma-%@-%@",
                name, [NSUUID UUID].UUIDString]];
    NSURL *destURL = [NSURL fileURLWithPath:dest];
    NSError *moveError = nil;
    if ([[NSFileManager defaultManager] moveItemAtURL:location
                                               toURL:destURL
                                                error:&moveError]) {
      resolve(dest);
    } else {
      reject(@"KELMA_DOWNLOAD",
             moveError.localizedDescription ?: @"Could not save the download.",
             moveError);
    }
  }];
  [task resume];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeKelmaShareSpecJSI>(params);
}

@end
