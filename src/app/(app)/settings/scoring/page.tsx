import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { SettingsHeader } from "../_components/settings-header";
import { ScoringEditor } from "./scoring-editor";

export const metadata = { title: "Scoring" };

export default async function ScoringPage() {
  await requireUser(["admin"]);
  const s = await getSettings(["scoring", "lists.industries", "lists.ageBands", "locations", "assignment"]);
  return (
    <div className="mx-auto max-w-6xl">
      <SettingsHeader
        title="Scoring"
        description="Every weight is a starting hypothesis. Change it here, watch the four worked examples move, then save. No code change needed."
      />
      <ScoringEditor
        initial={s.scoring}
        industries={s["lists.industries"]}
        ageBands={s["lists.ageBands"]}
        locations={s.locations}
        gccCountries={s.assignment.gccCountries}
      />
    </div>
  );
}
