import FamilyControls
import SwiftUI

/// The parent's screen for other apps, opened from the parent area: Apple's picker chooses the apps, and each one
/// gets its minutes a day. Names and icons come from the system (Label(token)) and never leave the iPad. Shown
/// in the child's language, the way the parent area is.
struct OtherAppsSheet: View {
    let spanish: Bool
    let onChange: () -> Void
    let onDone: () -> Void
    @State private var selection = OtherApps.shared.selection
    @State private var picks = OtherApps.shared.picks
    @State private var picking = false

    private func t(_ en: String, _ es: String) -> String { spanish ? es : en }
    private static let choices = [10, 15, 20, 30, 45, 60, 90, 120, OtherApps.noLimit]
    private func minutesLabel(_ m: Int) -> String { m == OtherApps.noLimit ? t("No limit", "Sin límite") : t("\(m) min a day", "\(m) min al día") }

    var body: some View {
        NavigationView {
            List {
                Section {
                    Button { picking = true } label: { Label(t("Pick apps", "Elegir apps"), systemImage: "plus.circle") }
                } footer: {
                    Text(t("The child opens these from the iPad's home screen while the Screen Time lockdown is on. When an app's minutes are used up, Screen Time closes it until midnight. With Guided Access on, the child stays inside Duckling and these apps do not open.",
                           "El niño o la niña abre estas apps desde la pantalla de inicio del iPad mientras el bloqueo de Tiempo en pantalla está activo. Cuando se acaban los minutos de una app, Tiempo en pantalla la cierra hasta la medianoche. Con Acceso guiado activo, el niño o la niña se queda dentro de Duckling y estas apps no se abren."))
                }
                if !picks.isEmpty {
                    Section(t("Allowed apps", "Apps permitidas")) {
                        ForEach(picks.keys.sorted(), id: \.self) { id in
                            if let pick = picks[id] {
                                HStack {
                                    Label(pick.token).labelStyle(.titleAndIcon)
                                    Spacer()
                                    Picker("", selection: Binding(get: { pick.minutes }, set: { m in OtherApps.shared.setMinutes(m, for: id); refresh() })) {
                                        ForEach(Self.choices, id: \.self) { m in Text(minutesLabel(m)).tag(m) }
                                    }
                                    .labelsHidden()
                                    .accessibilityLabel(t("Minutes a day", "Minutos al día"))
                                }
                            }
                        }
                        .onDelete { offsets in
                            let ids = picks.keys.sorted()
                            for i in offsets { OtherApps.shared.remove(ids[i]) }
                            refresh()
                        }
                    }
                }
            }
            .navigationTitle(t("Other apps", "Otras apps"))
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(t("Done", "Listo")) { onDone() } } }
            .familyActivityPicker(headerText: t("Apps the child may open", "Apps que el niño o la niña puede abrir"),
                                  footerText: t("Only apps count here; categories and websites are left out.", "Solo cuentan las apps; las categorías y los sitios web no."),
                                  isPresented: $picking, selection: $selection)
            .onChange(of: selection) { s in OtherApps.shared.update(selection: s); refresh() }
        }
        .navigationViewStyle(.stack)
    }

    private func refresh() {
        picks = OtherApps.shared.picks
        selection = OtherApps.shared.selection
        onChange()
    }
}
