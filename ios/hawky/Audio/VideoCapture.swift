import AVFoundation
import CoreImage
import Foundation
import UniformTypeIdentifiers
import UIKit

enum IPhoneVideoFrameRate: Int, CaseIterable, Identifiable {
    case fps1 = 1
    case fps2 = 2
    case fps5 = 5
    case fps10 = 10
    case fps15 = 15
    case fps24 = 24
    case fps30 = 30
    case fps60 = 60

    static let defaultFrameRate: IPhoneVideoFrameRate = .fps30

    var id: Int { rawValue }

    var label: String {
        "\(rawValue) fps"
    }

    static func storedValue(_ rawValue: Int) -> IPhoneVideoFrameRate {
        IPhoneVideoFrameRate(rawValue: rawValue) ?? defaultFrameRate
    }
}

// ---------------------------------------------------------------------------
// VideoCapture — wraps AVCaptureSession + AVAssetWriter to record streaming
// fMP4 video from the selected iPhone camera using the AVAssetWriterDelegate API.
//
// Design:
//  - Single camera session with selectable source FPS and 720p quality preset.
//  - AVAssetWriter initialized with UTType.mpeg4Movie (no URL) and
//    outputFileTypeProfile = .mpeg4CMAFCompliant for real fMP4 segments.
//  - preferredOutputSegmentInterval = 1s drives periodic segment callbacks.
//  - AVAssetWriterDelegate fires `assetWriter(_:didOutputSegmentData:…)`:
//      - .initialization  (ftyp+moov) — emitted once at start.
//      - .separable       (moof+mdat) — emitted every ~1s thereafter.
//  - `onSegment` is called on the main actor with (Data, Bool) where the
//    Bool is true for the initialization segment, false for separable.
//  - Caller (Recorder) wires onSegment → VideoUploader.ingest.
//  - `captureSession` is exposed read-only for VideoPreviewView's layer.
// ---------------------------------------------------------------------------

@MainActor
final class VideoCapture: NSObject, ObservableObject {

    // MARK: - Published

    @Published private(set) var permissionDenied: Bool = false

    // MARK: - Segment callback

    /// Called on the main actor for each fMP4 segment.
    /// `isInit` is true for the initialization segment (ftyp+moov),
    /// false for every subsequent separable media segment (moof+mdat).
    var onSegment: ((Data, Bool) -> Void)?

    /// Called on the main actor with a downscaled JPEG keyframe, sampled at
    /// roughly 1 FPS from the same capture stream as the preview.
    var onKeyframe: ((Data, UInt64) -> Void)?

    // MARK: - Session (for VideoPreviewView)

    private(set) var captureSession: AVCaptureSession?
    @Published private(set) var activeFrameRate: Int?

    // MARK: - Private state

    private var isRunning: Bool = false
    var preferredFrameRate: Int?
    var cameraPosition: AVCaptureDevice.Position = .back

    // Written on main actor during start/stop; read on capture queue inside
    // delegate callbacks. Declared nonisolated(unsafe) to allow access from
    // the background queue without main-actor hops on the real-time path.
    nonisolated(unsafe) private var assetWriter: AVAssetWriter?
    nonisolated(unsafe) private var assetWriterInput: AVAssetWriterInput?
    nonisolated(unsafe) private var sessionStarted: Bool = false
    nonisolated(unsafe) private var lastKeyframeNs: UInt64 = 0
    nonisolated(unsafe) var keyframeIntervalNs: UInt64 = 1_000_000_000

    // MARK: - Permission

    func requestPermissionIfNeeded() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            permissionDenied = false
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            permissionDenied = !granted
        default:
            permissionDenied = true
        }
    }

    // MARK: - Start / Stop

    func start(previewLayer: AVCaptureVideoPreviewLayer? = nil) async {
        guard !isRunning else { return }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            print("[VideoCapture] camera not authorized — skipping video capture")
            return
        }

        self.sessionStarted = false
        self.lastKeyframeNs = 0
        self.activeFrameRate = nil

        // Configure the asset writer without a URL (in-memory segment delivery).
        let writer = AVAssetWriter(contentType: UTType.mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4CMAFCompliant
        writer.preferredOutputSegmentInterval = CMTime(seconds: 1, preferredTimescale: 1)
        writer.initialSegmentStartTime = .zero
        writer.delegate = self

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 1280,
            AVVideoHeightKey: 720,
        ]
        let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        writerInput.expectsMediaDataInRealTime = true

        guard writer.canAdd(writerInput) else {
            print("[VideoCapture] cannot add video input to writer")
            return
        }
        writer.add(writerInput)
        self.assetWriter = writer
        self.assetWriterInput = writerInput

        // Configure capture session — video only.
        // Disable automatic audio-session management so that AVCaptureSession
        // does not reconfigure the shared AVAudioSession and corrupt the sample
        // rate already established by MicAudioSource. Without this flag the
        // session silently switches the hardware to 48 kHz even though no audio
        // input is added, causing MicAudioSource's tap to deliver 48 kHz buffers
        // that get tagged as 16 kHz by the uploader → 3× slow playback.
        let session = AVCaptureSession()
        session.automaticallyConfiguresApplicationAudioSession = false
        session.sessionPreset = .hd1280x720

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: cameraPosition),
              let deviceInput = try? AVCaptureDeviceInput(device: device) else {
            print("[VideoCapture] \(Self.label(for: cameraPosition)) not available — skipping video capture")
            return
        }
        if let preferredFrameRate {
            configureFrameRate(preferredFrameRate, on: device)
        }

        guard session.canAddInput(deviceInput) else {
            print("[VideoCapture] cannot add camera input")
            return
        }
        session.addInput(deviceInput)

        let videoOutput = AVCaptureVideoDataOutput()
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        let captureQueue = DispatchQueue(label: "live.videocapture.output",
                                         qos: .userInitiated)
        videoOutput.setSampleBufferDelegate(self, queue: captureQueue)
        videoOutput.alwaysDiscardsLateVideoFrames = true

        guard session.canAddOutput(videoOutput) else {
            print("[VideoCapture] cannot add video output")
            return
        }
        session.addOutput(videoOutput)

        // Deliver UPRIGHT buffers. Without this the camera buffer is rotated ~90°
        // (we saw roll≈-80° in every frame), so face thumbnails saved sideways and
        // detection was harder. Set the output connection to portrait, and un-mirror
        // the front camera so faces aren't flipped. (Mirrors face_ai's fix:
        // "we want the buffers in portrait otherwise they are rotated by 90 degrees".)
        if let connection = videoOutput.connection(with: .video) {
            if connection.isVideoOrientationSupported {
                connection.videoOrientation = .portrait
            }
            if cameraPosition == .front, connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = false
            }
        }

        if let preview = previewLayer {
            preview.session = session
        }

        self.captureSession = session
        self.isRunning = true

        // Start writer then session on a background thread.
        let writerRef = writer
        await Task.detached(priority: .userInitiated) {
            writerRef.startWriting()
            session.startRunning()
        }.value
    }

    func stop() async {
        guard isRunning else { return }
        isRunning = false

        let session = captureSession
        let writer = assetWriter
        let input = assetWriterInput

        await Task.detached(priority: .userInitiated) {
            session?.stopRunning()
            input?.markAsFinished()
            await writer?.finishWriting()
        }.value

        captureSession = nil
        activeFrameRate = nil
        assetWriter = nil
        assetWriterInput = nil
    }

    private func configureFrameRate(_ frameRate: Int, on device: AVCaptureDevice) {
        let requested = max(frameRate, 1)
        let supported = device.activeFormat.videoSupportedFrameRateRanges.contains { range in
            range.minFrameRate <= Double(requested) && Double(requested) <= range.maxFrameRate
        }
        guard supported else {
            print("[VideoCapture] requested \(requested) fps is unsupported by active camera format")
            return
        }

        do {
            try device.lockForConfiguration()
            let duration = CMTime(value: 1, timescale: CMTimeScale(requested))
            device.activeVideoMinFrameDuration = duration
            device.activeVideoMaxFrameDuration = duration
            device.unlockForConfiguration()
            activeFrameRate = requested
        } catch {
            print("[VideoCapture] failed to configure \(requested) fps: \(error)")
        }
    }

    private static func label(for position: AVCaptureDevice.Position) -> String {
        switch position {
        case .front: return "front camera"
        case .back: return "back camera"
        case .unspecified: return "camera"
        @unknown default: return "camera"
        }
    }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

extension VideoCapture: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let writer = assetWriter,
              let writerInput = assetWriterInput,
              writer.status == .writing,
              writerInput.isReadyForMoreMediaData else { return }

        // Start the writer session on the first sample only.
        if !sessionStarted {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
        }

        writerInput.append(sampleBuffer)
        maybeEmitKeyframe(from: sampleBuffer)
    }

    private nonisolated func maybeEmitKeyframe(from sampleBuffer: CMSampleBuffer) {
        let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        if lastKeyframeNs != 0 && nowNs - lastKeyframeNs < keyframeIntervalNs { return }
        lastKeyframeNs = nowNs

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let jpeg = Self.makeJPEG(from: pixelBuffer) else { return }

        Task { @MainActor [weak self] in
            self?.onKeyframe?(jpeg, nowNs)
        }
    }

    private nonisolated static func makeJPEG(from pixelBuffer: CVPixelBuffer) -> Data? {
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let width = max(ciImage.extent.width, 1)
        let scale = min(1, 640 / width)
        let resized = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(resized, from: resized.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.65)
    }
}

// MARK: - AVAssetWriterDelegate

extension VideoCapture: AVAssetWriterDelegate {
    nonisolated func assetWriter(
        _ writer: AVAssetWriter,
        didOutputSegmentData segmentData: Data,
        segmentType: AVAssetSegmentType,
        segmentReport: AVAssetSegmentReport?
    ) {
        let isInit = (segmentType == .initialization)
        // Hop to the main actor before delivering to caller.
        Task { @MainActor [weak self] in
            self?.onSegment?(segmentData, isInit)
        }
    }
}
