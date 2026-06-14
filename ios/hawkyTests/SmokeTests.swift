import Testing

@Suite struct SmokeTests {
    @Test func trivialPasses() {
        #expect(1 + 1 == 2)
    }
}
