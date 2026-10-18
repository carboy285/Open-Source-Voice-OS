import XCTest
@testable import Murmur

final class SpeechTextTests: XCTestCase {
    func testDropsMarkdownMarks() {
        XCTAssertEqual(SpeechText.clean("**Your** dentist is at `3pm`"), "Your dentist is at 3pm.")
        XCTAssertEqual(SpeechText.clean("## Plan\n- call Ana\n- book lunch"), "Plan. call Ana. book lunch.")
    }

    func testReadsALinkAsALink() {
        XCTAssertEqual(SpeechText.clean("See [the doc](https://example.com/a/b?c=d) now."), "See the doc now.")
        XCTAssertEqual(SpeechText.clean("Open https://example.com/very/long/path today"), "Open a link today.")
    }

    func testKeepsOwnPunctuationAndJoinsLines() {
        XCTAssertEqual(SpeechText.clean("Done!\nAnything else?"), "Done! Anything else?")
        XCTAssertEqual(SpeechText.clean("了解しました"), "了解しました。")
    }

    func testEmptyStaysEmptyAndLongTextIsCut() {
        XCTAssertEqual(SpeechText.clean("   \n  "), "")
        XCTAssertEqual(SpeechText.clean(String(repeating: "a", count: 3000), limit: 100).count, 100)
    }
}
