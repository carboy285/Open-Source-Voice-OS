import XCTest
import SwiftUI
@testable import Murmur

final class OnboardingLayoutTests: XCTestCase {
    @MainActor func testGuidedSetupFitsItsWindowInBothLanguages() throws {
        _ = NSApplication.shared
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let model = AppModel()
        for locale in ["en", "ja"] {
            let data = try Data(contentsOf: root.appendingPathComponent("src/i18n/\(locale).json"))
            let table = try JSONDecoder().decode([String: String].self, from: data)
            L.load(table, locale: locale)
            for step in 0..<4 {
                let host = NSHostingView(rootView: OnboardingView(initialStep: step).environmentObject(model).environmentObject(L))
                host.frame = NSRect(x: 0, y: 0, width: 640, height: 680)
                host.layoutSubtreeIfNeeded()
                XCTAssertEqual(host.fittingSize.width, 640, accuracy: 1)
                XCTAssertEqual(host.fittingSize.height, 680, accuracy: 1)
                if let directory = ProcessInfo.processInfo.environment["MURMUR_SETUP_PREVIEW_DIR"] {
                    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("setup-\(locale)-\(step).png"))
                }
            }
        }
    }
}
