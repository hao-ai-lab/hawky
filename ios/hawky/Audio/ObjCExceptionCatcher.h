#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Bridges Objective-C `NSException`s into Swift errors. Swift `do/catch` cannot
/// catch an Obj-C exception, so AVAudioEngine graph mutations
/// (setVoiceProcessingEnabled / connect / attach / installTap) that raise an
/// NSException — e.g. when another app holds the voice-processing mic, or on a
/// format mismatch — abort the whole process (SIGABRT) instead of failing
/// recoverably. Wrap those calls in `tryBlock:error:` so they throw instead. (#673)
@interface ObjCExceptionCatcher : NSObject

/// Runs `block`; returns YES on success, or NO with `error` populated if the
/// block raised an Obj-C `NSException`.
+ (BOOL)tryBlock:(NS_NOESCAPE void (^)(void))block
           error:(NSError * _Nullable * _Nullable)error
    NS_SWIFT_NAME(catching(_:));

@end

NS_ASSUME_NONNULL_END
