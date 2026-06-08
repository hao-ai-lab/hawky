import SwiftUI

struct CarouselPageIndicator: View {
    let items: [String]
    let selectedIndex: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                let isSelected = index == selectedIndex
                Text(item)
                    .font(.caption2.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color(.label) : Color(.secondaryLabel))
                    .lineLimit(1)
                    .padding(.horizontal, isSelected ? 8 : 6)
                    .padding(.vertical, 4)
                    .background(
                        Capsule(style: .continuous)
                            .fill(isSelected ? DesignTokens.accent.opacity(0.22) : Color.clear)
                    )
            }
        }
        .padding(3)
        .softGlass(in: Capsule(style: .continuous))
        .accessibilityElement(children: .ignore)
    }
}

struct SessionSearchCreateBar: View {
    @Binding var searchText: String
    let placeholder: String
    let actionTitle: String
    let actionIcon: String
    let isActionDisabled: Bool
    var focusBinding: FocusState<Bool>.Binding? = nil
    let onCancelSearch: () -> Void
    let action: () -> Void

    private var isSearching: Bool {
        focusBinding?.wrappedValue == true
    }

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                textField
            }
            .font(.body)
            .padding(.horizontal, 12)
            .frame(height: 44)
            .softGlass(in: Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(Color(.separator).opacity(0.45), lineWidth: 0.5)
            )

            Button {
                if isSearching {
                    onCancelSearch()
                } else {
                    action()
                }
            } label: {
                if isSearching {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .background(Color(.label), in: Capsule(style: .continuous))
                        .foregroundStyle(Color(.systemBackground))
                } else {
                    Label(actionTitle, systemImage: actionIcon)
                        .font(.body.weight(.semibold))
                        .labelStyle(.titleAndIcon)
                        .lineLimit(1)
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .background(Color(.label), in: Capsule(style: .continuous))
                        .foregroundStyle(Color(.systemBackground))
                }
            }
            .disabled(!isSearching && isActionDisabled)
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .background(.regularMaterial)
    }

    @ViewBuilder
    private var textField: some View {
        if let focusBinding {
            TextField(placeholder, text: $searchText)
                .focused(focusBinding)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
        } else {
            TextField(placeholder, text: $searchText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
        }
    }
}
