import AppKit
import CoreGraphics
import ScreenCaptureKit
import Vision

/// Where a drawn loop points: the box around it, kept on the screen.
enum CircleGeometry {
    /// `path` is in screen-local points with the origin at the top left. Nil when the drawing is too small to mean anything.
    static func region(path: [CGPoint], bounds: CGRect, padding: CGFloat = 14, minimum: CGFloat = 24) -> CGRect? {
        guard path.count >= 2,
              let minX = path.map(\.x).min(), let maxX = path.map(\.x).max(),
              let minY = path.map(\.y).min(), let maxY = path.map(\.y).max()
        else { return nil }
        guard maxX - minX >= minimum, maxY - minY >= minimum else { return nil }
        let box = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
            .insetBy(dx: -padding, dy: -padding)
            .intersection(bounds)
        guard !box.isNull, box.width >= 1, box.height >= 1 else { return nil }
        return box
    }
}

enum GrabError: LocalizedError {
    case noDisplay, noWindow

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "That screen is not available."
        case .noWindow: return "There is no window to look at."
        }
    }
}

/// Takes the pictures Murmur looks at: the area you circled, or the window you are working in. Needs Screen Recording.
enum ScreenGrabber {
    static func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber).map { CGDirectDisplayID($0.uint32Value) }
    }

    /// `region` is in points on that display, origin at its top left. Murmur's own windows are left out.
    @available(macOS 14.0, *)
    static func capture(region: CGRect, displayID: CGDirectDisplayID) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw GrabError.noDisplay }
        let own = content.windows.filter { $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingWindows: own)
        let configuration = SCStreamConfiguration()
        configuration.sourceRect = region
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = max(1, Int(region.width * scale))
        configuration.height = max(1, Int(region.height * scale))
        configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    /// The biggest ordinary window of an app, even when something covers it.
    @available(macOS 14.0, *)
    static func captureWindow(pid: pid_t) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let candidates = content.windows.filter {
            $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 120 && $0.frame.height > 80
        }
        guard let window = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw GrabError.noWindow
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = max(1, Int(window.frame.width * scale))
        configuration.height = max(1, Int(window.frame.height * scale))
        configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }
}

/// Reads the words in a picture on this Mac. Nothing is sent anywhere for it.
enum TextReader {
    static func read(_ image: CGImage) async -> String {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = true
                request.automaticallyDetectsLanguage = true
                do {
                    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
                    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                    continuation.resume(returning: String(lines.joined(separator: "\n").prefix(4000)))
                } catch {
                    continuation.resume(returning: "")
                }
            }
        }
    }
}

/// Makes a picture small enough to send: at most 1568 px on the long side, PNG, or JPEG when the PNG is still big.
enum ImagePrep {
    struct Encoded {
        let mediaType: String
        let base64: String
    }

    static func encode(_ image: CGImage, maxSide: CGFloat = 1568) -> Encoded? {
        var picture = image
        let longest = CGFloat(max(image.width, image.height))
        if longest > maxSide {
            let scale = maxSide / longest
            let width = max(1, Int(CGFloat(image.width) * scale))
            let height = max(1, Int(CGFloat(image.height) * scale))
            guard let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return nil }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            guard let scaled = context.makeImage() else { return nil }
            picture = scaled
        }
        let rep = NSBitmapImageRep(cgImage: picture)
        if let png = rep.representation(using: .png, properties: [:]), png.count < 4_500_000 {
            return Encoded(mediaType: "image/png", base64: png.base64EncodedString())
        }
        if let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) {
            return Encoded(mediaType: "image/jpeg", base64: jpeg.base64EncodedString())
        }
        return nil
    }
}
