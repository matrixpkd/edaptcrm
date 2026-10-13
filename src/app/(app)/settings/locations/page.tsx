import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Textarea } from "@/components/ui/form";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { RecalcButton } from "../_components/recalc-button";
import { FormSubmit, SettingsForm } from "../_components/settings-form";
import { SettingsHeader } from "../_components/settings-header";
import { recalcScoresChunkAction } from "../actions";
import { saveLocationsAction } from "./actions";

export const metadata = { title: "Locations" };

export default async function LocationsPage() {
  await requireUser(["admin"]);
  const s = await getSettings(["locations", "scoring"]);
  const loc = s.locations;
  const pts = s.scoring.fit.location;
  const lists: { name: "keralaCities" | "indianMetros" | "keralaStateNames"; label: string; hint: string; rows: number }[] = [
    {
      name: "keralaCities",
      label: `Kerala cities (${loc.keralaCities.length})`,
      hint: `With Indian metros: "Kerala cities and Indian metros", ${pts.kerala_city_or_metro} Fit points. Add common spellings too (Calicut, Kozhikode).`,
      rows: 8,
    },
    { name: "indianMetros", label: `Indian metros (${loc.indianMetros.length})`, hint: "Same band as Kerala cities.", rows: 8 },
    {
      name: "keralaStateNames",
      label: `Spellings of Kerala (${loc.keralaStateNames.length})`,
      hint: `What people type in the state field. Matching any of these, but not a listed city: "Rest of Kerala", ${pts.rest_of_kerala} points.`,
      rows: 3,
    },
  ];
  return (
    <div className="mx-auto max-w-4xl">
      <SettingsHeader
        title="Locations"
        description="How Fit scoring tells a Kerala city from the rest of Kerala and the rest of India. Case, spaces and punctuation are ignored when matching."
      />
      <Card>
        <CardHeader title="Places" description="One per line." />
        <CardBody>
          <SettingsForm action={saveLocationsAction} aria-label="Locations">
            <div className="grid gap-4 md:grid-cols-2">
              {lists.map((l) => (
                <Field key={l.name} label={l.label} htmlFor={l.name} hint={l.hint} className={l.name === "keralaStateNames" ? "md:col-span-2" : undefined}>
                  <Textarea id={l.name} name={l.name} rows={l.rows} defaultValue={loc[l.name].join("\n")} className="font-mono text-sm" spellCheck={false} />
                </Field>
              ))}
            </div>
            <div className="mt-4">
              <FormSubmit pendingText="Saving…">Save locations</FormSubmit>
            </div>
          </SettingsForm>
          <div className="mt-6 border-t border-border pt-4">
            <RecalcButton action={recalcScoresChunkAction} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
