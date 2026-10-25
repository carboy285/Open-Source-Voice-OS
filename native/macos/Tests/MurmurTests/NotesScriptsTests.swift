import XCTest
@testable import Murmur

final class NotesScriptsTests: XCTestCase {
    func testTitleAndLinesBecomeHTML() {
        XCTAssertEqual(NotesScripts.html(title: "Groceries", body: "milk\n\neggs"), "<h1>Groceries</h1><div>milk</div><div><br></div><div>eggs</div>")
        XCTAssertEqual(NotesScripts.html(title: "Just a title", body: ""), "<h1>Just a title</h1>")
    }

    func testUserTextCannotInjectMarkup() {
        XCTAssertEqual(NotesScripts.html(title: "a < b & c", body: "<img src=x onerror=alert(1)>"), "<h1>a &lt; b &amp; c</h1><div>&lt;img src=x onerror=alert(1)&gt;</div>")
    }

    func testWindowsLineEndingsAreOneBreak() {
        XCTAssertEqual(NotesScripts.html(title: "t", body: "a\r\nb"), "<h1>t</h1><div>a</div><div>b</div>")
    }

    func testValuesTravelAsArgumentsNotScriptText() {
        XCTAssertTrue(NotesScripts.create.contains("item 1 of argv"))
        XCTAssertFalse(NotesScripts.create.contains("\\("))
    }
}
