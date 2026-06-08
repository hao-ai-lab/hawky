import SwiftUI

// =============================================================================
// LivePeopleDatabaseView — browse the Cocktail Party person database (#627).
//
// Shows everyone the model has learned: face thumbnail, name, and facts. Pulls
// from the DeepFace service via the bridge (LiveSessionStore.fetchPeople). The DB
// is server-side; this is a read-only viewer with pull-to-refresh.
// =============================================================================

struct LivePeopleDatabaseView: View {
    let store: LiveSessionStore

    @State private var people: [LivePerson] = []
    @State private var isLoading = true
    @State private var showClearConfirm = false
    @State private var isClearing = false

    var body: some View {
        List {
            if isLoading && people.isEmpty {
                HStack { Spacer(); ProgressView(); Spacer() }
                    .listRowBackground(Color.clear)
            } else if people.isEmpty {
                ContentUnavailableView(
                    "No people yet",
                    systemImage: "person.crop.square.badge.questionmark",
                    description: Text("Turn on Cocktail Party Mode and point the camera at someone to start building the database.")
                )
            } else {
                ForEach(people) { person in
                    LivePersonRow(person: person)
                }
            }
        }
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) {
                    showClearConfirm = true
                } label: {
                    if isClearing { ProgressView() } else { Text("Clear") }
                }
                .disabled(people.isEmpty || isClearing)
                .accessibilityIdentifier("live.peopleDatabase.clear")
            }
        }
        .confirmationDialog(
            "Clear the entire people database? This deletes every saved person and can't be undone.",
            isPresented: $showClearConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete all \(people.count) people", role: .destructive) {
                Task { await clearAll() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func clearAll() async {
        isClearing = true
        let ok = await store.clearPeople()
        if ok { people = [] }
        isClearing = false
        await load()
    }

    private func load() async {
        isLoading = true
        let fetched = await store.fetchPeople()
        people = fetched.sorted { $0.name.lowercased() < $1.name.lowercased() }
        isLoading = false
    }
}

private struct LivePersonRow: View {
    let person: LivePerson

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            thumbnail
            VStack(alignment: .leading, spacing: 4) {
                Text(person.name.isEmpty ? "Unknown" : person.name)
                    .font(DesignTokens.Font.panelTitle)
                if !person.facts.isEmpty {
                    ForEach(person.facts.prefix(4), id: \.self) { fact in
                        Text("• \(fact)")
                            .font(DesignTokens.Font.panelBody)
                            .foregroundStyle(.secondary)
                    }
                }
                if let recap = person.lastRecap, !recap.isEmpty {
                    Text("Last: \(recap)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var thumbnail: some View {
        if let b64 = person.thumbnailBase64,
           let data = Data(base64Encoded: b64),
           let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.quaternary)
                .frame(width: 56, height: 56)
                .overlay(Image(systemName: "person.fill").foregroundStyle(.secondary))
        }
    }
}
