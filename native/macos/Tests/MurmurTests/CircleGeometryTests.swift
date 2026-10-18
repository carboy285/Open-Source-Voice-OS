import XCTest
@testable import Murmur

final class CircleGeometryTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 700)

    private func loop(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> [CGPoint] {
        [CGPoint(x: x, y: y), CGPoint(x: x + w, y: y), CGPoint(x: x + w, y: y + h), CGPoint(x: x, y: y + h), CGPoint(x: x, y: y)]
    }

    func testTheBoxAroundALoopIsPadded() {
        let region = CircleGeometry.region(path: loop(100, 100, 200, 100), bounds: screen)
        XCTAssertEqual(region, CGRect(x: 86, y: 86, width: 228, height: 128))
    }

    func testTheBoxStaysOnTheScreen() {
        let region = CircleGeometry.region(path: loop(0, 0, 100, 100), bounds: screen)
        XCTAssertEqual(region, CGRect(x: 0, y: 0, width: 114, height: 114))
        let far = CircleGeometry.region(path: loop(950, 650, 100, 100), bounds: screen)
        XCTAssertEqual(far?.maxX, 1000)
        XCTAssertEqual(far?.maxY, 700)
    }

    func testAClickOrATinyOrThinDrawingMeansNothing() {
        XCTAssertNil(CircleGeometry.region(path: [CGPoint(x: 5, y: 5)], bounds: screen))
        XCTAssertNil(CircleGeometry.region(path: loop(100, 100, 10, 10), bounds: screen))
        XCTAssertNil(CircleGeometry.region(path: loop(100, 100, 300, 3), bounds: screen))
        XCTAssertNil(CircleGeometry.region(path: [], bounds: screen))
    }

    func testADrawingOffTheScreenMeansNothing() {
        XCTAssertNil(CircleGeometry.region(path: loop(2000, 2000, 100, 100), bounds: screen))
    }
}
