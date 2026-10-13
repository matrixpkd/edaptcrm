/**
 * Pure building blocks shared by the demo seeder (scripts/seed-demo.ts) and the scale seeder
 * (scripts/seed-scale.ts): a seeded PRNG, names typical of Kerala and the Gulf, cities, valid phone numbers
 * and emails. Nothing here touches the database, so both seeders produce the same people for the same seed.
 */
import { normalizePhone } from "@/lib/phone";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32): deterministic, fast, good enough for fake data
// ---------------------------------------------------------------------------

export type Rng = {
  /** [0, 1) */
  next(): number;
  /** integer in [min, max] */
  int(min: number, max: number): number;
  /** float in [min, max) */
  float(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  /** entries are [value, weight] */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  shuffle<T>(xs: T[]): T[];
  /** `n` lower-case hex characters */
  hex(n: number): string;
  /** `n` decimal digits (may start with 0) */
  digits(n: number): string;
  /** a new independent stream derived from this one */
  fork(salt: number): Rng;
};

export function createRng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (xs) => {
      if (!xs.length) throw new Error("pick() from an empty list");
      return xs[Math.floor(next() * xs.length)];
    },
    weighted: (entries) => {
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [v, w] of entries) {
        r -= w;
        if (r < 0) return v;
      }
      return entries[entries.length - 1][0];
    },
    shuffle: (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    },
    hex: (n) => {
      let s = "";
      for (let i = 0; i < n; i++) s += Math.floor(next() * 16).toString(16);
      return s;
    },
    digits: (n) => {
      let s = "";
      for (let i = 0; i < n; i++) s += Math.floor(next() * 10).toString();
      return s;
    },
    fork: (salt) => createRng((Math.floor(next() * 4294967296) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0),
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export type Community = "malayali_muslim" | "malayali_hindu" | "malayali_christian" | "arab" | "north_indian" | "tamil";
export type Gender = "m" | "f";

type NameBank = { m: readonly string[]; f: readonly string[]; last: readonly string[]; initials?: readonly string[] };

const NAMES: Record<Community, NameBank> = {
  malayali_muslim: {
    m: [
      "Muhammed", "Ashraf", "Shafeeq", "Faisal", "Anas", "Rashid", "Nizar", "Shihab", "Jaseem", "Irshad", "Sameer",
      "Riyas", "Shameer", "Haris", "Fasil", "Nabeel", "Suhail", "Afsal", "Jabir", "Mansoor", "Siraj", "Thoufeeq",
      "Arshad", "Shabeer", "Muneer", "Rafeeq", "Noushad", "Ajmal", "Sinan", "Hisham", "Basheer", "Jamsheer",
      "Abdul Rahman", "Abdul Latheef", "Abdul Gafoor", "Mubarak", "Navas", "Shanavas", "Yaseen", "Zubair",
    ],
    f: [
      "Fathima", "Ayisha", "Shahana", "Nafeesa", "Sumayya", "Hiba", "Fida", "Rinsha", "Jasna", "Shabna", "Safa",
      "Nihala", "Shirin", "Hanna", "Fasna", "Raihana", "Sabeena", "Najla", "Thasni", "Ameena", "Sajna", "Haseena",
    ],
    last: [
      "Rahman", "Ali", "Koya", "Basheer", "Musthafa", "Ahammed", "Kutty", "Haji", "Hameed", "Kareem", "Salim",
      "Moideen", "Aboobacker", "Noushad", "Hussain", "Ibrahim", "Latheef", "Majeed", "Rasheed", "Yousuf",
    ],
    initials: ["K", "P", "T", "C", "M", "V", "K P", "P K", "C K", "T P"],
  },
  malayali_hindu: {
    m: [
      "Arun", "Vishnu", "Rahul", "Akhil", "Anoop", "Sreejith", "Sajeev", "Rajesh", "Manoj", "Vineeth", "Hari",
      "Gokul", "Nikhil", "Sandeep", "Pradeep", "Ajith", "Sunil", "Suresh", "Ramesh", "Unnikrishnan", "Krishnadas",
      "Deepak", "Jithin", "Sarath", "Abhilash", "Midhun", "Vivek", "Anand", "Prasanth", "Sudheesh", "Renjith",
    ],
    f: [
      "Anjali", "Lakshmi", "Divya", "Sreelakshmi", "Aswathy", "Arya", "Neethu", "Remya", "Deepa", "Sindhu",
      "Parvathy", "Gopika", "Meenakshi", "Anu", "Sneha", "Athira", "Revathy", "Keerthana", "Devika", "Sruthi",
    ],
    last: [
      "Nair", "Menon", "Pillai", "Nambiar", "Kurup", "Warrier", "Panicker", "Varma", "Das", "Kumar", "Krishnan",
      "Mohan", "Raj", "Gopinath", "Unnithan", "Namboothiri", "Prakash", "Chandran", "Balan", "Sasidharan",
    ],
  },
  malayali_christian: {
    m: [
      "Jose", "Thomas", "Mathew", "George", "Abraham", "Jacob", "Tony", "Shibu", "Jijo", "Bibin", "Linto", "Sijo",
      "Roy", "Varghese", "Kuriakose", "Alex", "Jobin", "Anson", "Ebin", "Sebastian", "Benny", "Jinson", "Shaji",
    ],
    f: [
      "Mariya", "Ann", "Teena", "Jisha", "Bincy", "Liya", "Riya", "Elizabeth", "Ancy", "Neenu", "Jincy", "Sheeba",
      "Mini", "Rosily", "Sherin", "Ashly", "Jismy", "Treesa", "Nimmy", "Merin",
    ],
    last: [
      "Thomas", "Joseph", "Mathew", "Varghese", "George", "Kurian", "Chacko", "Philip", "Abraham", "Jacob",
      "Antony", "Paul", "Sebastian", "John", "Cherian", "Mathai", "Isaac", "Daniel",
    ],
  },
  arab: {
    m: [
      "Ahmed", "Mohammed", "Khalid", "Omar", "Yousef", "Abdullah", "Saeed", "Hamad", "Rashid", "Sultan", "Majid",
      "Tariq", "Hassan", "Ali", "Ibrahim", "Salem", "Nasser", "Hamdan", "Waleed", "Adel", "Fahad", "Mansour",
    ],
    f: ["Fatima", "Mariam", "Aisha", "Noura", "Hessa", "Latifa", "Sara", "Reem", "Amna", "Maitha", "Mona", "Layla", "Huda", "Dana"],
    last: [
      "Al Mansoori", "Al Nuaimi", "Al Hashimi", "Al Suwaidi", "Al Shamsi", "Al Ketbi", "Al Mazrouei", "Al Falasi",
      "Al Marri", "Al Harthy", "Al Ghamdi", "Al Otaibi", "Al Kuwari", "Al Dosari", "Al Zahrani", "Haddad", "Khoury",
      "Saleh", "Al Ameri", "Al Balushi",
    ],
  },
  north_indian: {
    m: ["Rohan", "Ankit", "Rahul", "Sanjay", "Vikram", "Aditya", "Siddharth", "Amit", "Saurabh", "Nitin", "Varun", "Kunal", "Farhan", "Imran"],
    f: ["Priya", "Neha", "Pooja", "Meghna", "Ananya", "Ritu", "Shreya", "Kavya", "Nidhi", "Swati", "Ayesha"],
    last: ["Sharma", "Gupta", "Verma", "Singh", "Patel", "Mehta", "Jain", "Kulkarni", "Joshi", "Bose", "Chatterjee", "Agarwal", "Shaikh", "Qureshi", "Malhotra"],
  },
  tamil: {
    m: ["Karthik", "Senthil", "Arjun", "Prakash", "Vignesh", "Balaji", "Suresh", "Ganesh", "Dinesh", "Muthu", "Ashwin"],
    f: ["Divya", "Lakshmi", "Priya", "Kavitha", "Revathi", "Saranya", "Meena", "Janani", "Gayathri"],
    last: ["Subramanian", "Iyer", "Narayanan", "Rajan", "Krishnamurthy", "Venkatesh", "Sundaram", "Ramasamy", "Natarajan", "Selvam"],
  },
};

/** "Fathima Shirin", "Arun Nair", "Rinsha K", "Ahmed Al Mansoori" */
export function personName(rng: Rng, community: Community, gender: Gender): { first: string; last: string; name: string } {
  const bank = NAMES[community];
  const first = rng.pick(bank[gender]);
  // Malayali Muslims often go by a second given name or initials rather than a family name
  const useInitials = bank.initials && rng.chance(0.3);
  let last = useInitials ? rng.pick(bank.initials!) : rng.pick(gender === "f" && community === "malayali_muslim" && rng.chance(0.5) ? bank.f : bank.last);
  if (last === first || first.split(" ").includes(last)) last = rng.pick(bank.last.filter((x) => !first.split(" ").includes(x)));
  return { first, last, name: `${first} ${last}` };
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export type Region = "kerala" | "metro" | "india" | "gcc";
export type City = { city: string; state: string | null; country: string; region: Region; weight: number };

export const CITIES: readonly City[] = [
  // Kerala (the home market)
  { city: "Kozhikode", state: "Kerala", country: "IN", region: "kerala", weight: 14 },
  { city: "Malappuram", state: "Kerala", country: "IN", region: "kerala", weight: 13 },
  { city: "Kochi", state: "Kerala", country: "IN", region: "kerala", weight: 12 },
  { city: "Thrissur", state: "Kerala", country: "IN", region: "kerala", weight: 9 },
  { city: "Thiruvananthapuram", state: "Kerala", country: "IN", region: "kerala", weight: 8 },
  { city: "Kannur", state: "Kerala", country: "IN", region: "kerala", weight: 7 },
  { city: "Palakkad", state: "Kerala", country: "IN", region: "kerala", weight: 5 },
  { city: "Kollam", state: "Kerala", country: "IN", region: "kerala", weight: 4 },
  { city: "Kottayam", state: "Kerala", country: "IN", region: "kerala", weight: 4 },
  { city: "Alappuzha", state: "Kerala", country: "IN", region: "kerala", weight: 3 },
  { city: "Kasaragod", state: "Kerala", country: "IN", region: "kerala", weight: 3 },
  { city: "Perinthalmanna", state: "Kerala", country: "IN", region: "kerala", weight: 3 },
  { city: "Manjeri", state: "Kerala", country: "IN", region: "kerala", weight: 3 },
  { city: "Tirur", state: "Kerala", country: "IN", region: "kerala", weight: 3 },
  { city: "Vadakara", state: "Kerala", country: "IN", region: "kerala", weight: 2 },
  { city: "Koduvally", state: "Kerala", country: "IN", region: "kerala", weight: 2 },
  { city: "Thalassery", state: "Kerala", country: "IN", region: "kerala", weight: 2 },
  { city: "Kalpetta", state: "Kerala", country: "IN", region: "kerala", weight: 2 },
  { city: "Aluva", state: "Kerala", country: "IN", region: "kerala", weight: 2 },
  { city: "Thodupuzha", state: "Kerala", country: "IN", region: "kerala", weight: 1 },
  { city: "Pathanamthitta", state: "Kerala", country: "IN", region: "kerala", weight: 1 },
  // Indian metros
  { city: "Bengaluru", state: "Karnataka", country: "IN", region: "metro", weight: 9 },
  { city: "Chennai", state: "Tamil Nadu", country: "IN", region: "metro", weight: 5 },
  { city: "Mumbai", state: "Maharashtra", country: "IN", region: "metro", weight: 4 },
  { city: "Hyderabad", state: "Telangana", country: "IN", region: "metro", weight: 3 },
  { city: "Pune", state: "Maharashtra", country: "IN", region: "metro", weight: 3 },
  { city: "New Delhi", state: "Delhi", country: "IN", region: "metro", weight: 2 },
  // rest of India
  { city: "Coimbatore", state: "Tamil Nadu", country: "IN", region: "india", weight: 3 },
  { city: "Mangaluru", state: "Karnataka", country: "IN", region: "india", weight: 2 },
  { city: "Madurai", state: "Tamil Nadu", country: "IN", region: "india", weight: 1 },
  // the Gulf
  { city: "Dubai", state: null, country: "AE", region: "gcc", weight: 16 },
  { city: "Abu Dhabi", state: null, country: "AE", region: "gcc", weight: 7 },
  { city: "Sharjah", state: null, country: "AE", region: "gcc", weight: 7 },
  { city: "Ajman", state: null, country: "AE", region: "gcc", weight: 2 },
  { city: "Al Ain", state: null, country: "AE", region: "gcc", weight: 2 },
  { city: "Riyadh", state: null, country: "SA", region: "gcc", weight: 3 },
  { city: "Jeddah", state: null, country: "SA", region: "gcc", weight: 2 },
  { city: "Dammam", state: null, country: "SA", region: "gcc", weight: 2 },
  { city: "Doha", state: null, country: "QA", region: "gcc", weight: 4 },
  { city: "Kuwait City", state: null, country: "KW", region: "gcc", weight: 1 },
  { city: "Muscat", state: null, country: "OM", region: "gcc", weight: 1 },
  { city: "Manama", state: null, country: "BH", region: "gcc", weight: 1 },
];

export const REGION_WEIGHTS: readonly (readonly [Region, number])[] = [
  ["kerala", 62],
  ["gcc", 25],
  ["metro", 10],
  ["india", 3],
];

export function pickCity(rng: Rng, region: Region): City {
  return rng.weighted(CITIES.filter((c) => c.region === region).map((c) => [c, c.weight] as const));
}

export function cityByName(name: string): City {
  const c = CITIES.find((x) => x.city === name);
  if (!c) throw new Error(`Unknown seed city ${name}`);
  return c;
}

function communityFor(rng: Rng, region: Region, city: City): Community {
  const malayali = (): Community =>
    rng.weighted([
      ["malayali_muslim", 45],
      ["malayali_hindu", 35],
      ["malayali_christian", 20],
    ]);
  switch (region) {
    case "kerala":
      return malayali();
    case "gcc":
      return rng.weighted([
        [malayali(), 74],
        ["arab", 21],
        ["north_indian", 5],
      ]);
    case "metro":
      return rng.weighted([
        [malayali(), 55],
        ["north_indian", city.city === "Chennai" ? 10 : 30],
        ["tamil", city.city === "Chennai" ? 35 : 15],
      ]);
    case "india":
      return rng.weighted([
        [malayali(), 40],
        ["tamil", 35],
        ["north_indian", 25],
      ]);
  }
}

function languageFor(rng: Rng, community: Community): string {
  switch (community) {
    case "arab":
      return rng.chance(0.7) ? "ar" : "en";
    case "north_indian":
      return rng.chance(0.45) ? "hi" : "en";
    case "tamil":
      return rng.chance(0.6) ? "ta" : "en";
    default:
      return rng.chance(0.86) ? "ml" : "en";
  }
}

// ---------------------------------------------------------------------------
// Phones and emails
// ---------------------------------------------------------------------------

/** Mobile number patterns per country: [prefix choices, digits after the prefix]. */
const MOBILE: Record<string, { code: string; prefixes: readonly string[]; rest: number }> = {
  IN: { code: "91", prefixes: ["98", "97", "96", "95", "94", "90", "99", "89", "88", "87", "85", "81", "80", "79", "78", "77", "75", "73", "70", "63"], rest: 8 },
  AE: { code: "971", prefixes: ["50", "52", "54", "55", "56", "58"], rest: 7 },
  SA: { code: "966", prefixes: ["50", "53", "54", "55", "56", "59"], rest: 7 },
  QA: { code: "974", prefixes: ["33", "55", "66", "70", "77"], rest: 6 },
  KW: { code: "965", prefixes: ["5", "6", "9"], rest: 7 },
  OM: { code: "968", prefixes: ["91", "92", "95", "99"], rest: 6 },
  BH: { code: "973", prefixes: ["33", "36", "39"], rest: 6 },
};

/** The country of a number this module made (by its dialling code). */
export function countryOfPhone(e164: string): string {
  for (const [country, m] of Object.entries(MOBILE)) if (e164.startsWith(`+${m.code}`)) return country;
  return "IN";
}

/** A valid, unused mobile number in E.164 for the country (checked with the same library the CRM uses). */
export function mobileNumber(rng: Rng, country: string, used: Set<string>): string {
  const m = MOBILE[country] ?? MOBILE.IN;
  for (let attempt = 0; attempt < 200; attempt++) {
    const raw = `+${m.code}${rng.pick(m.prefixes)}${rng.digits(m.rest)}`;
    if (used.has(raw)) continue;
    const np = normalizePhone(raw);
    if (!np || np.e164 !== raw || used.has(np.e164)) continue;
    used.add(np.e164);
    return np.e164;
  }
  throw new Error(`Could not make a unique ${country} mobile number`);
}

const EMAIL_DOMAINS_IN: readonly (readonly [string, number])[] = [
  ["gmail.com", 82],
  ["yahoo.com", 7],
  ["outlook.com", 5],
  ["rediffmail.com", 3],
  ["hotmail.com", 3],
];
const EMAIL_DOMAINS_GCC: readonly (readonly [string, number])[] = [
  ["gmail.com", 70],
  ["hotmail.com", 12],
  ["outlook.com", 10],
  ["yahoo.com", 8],
];

export function emailFor(rng: Rng, first: string, last: string, region: Region, used: Set<string>): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const f = clean(first);
  const l = clean(last);
  const domain = rng.weighted(region === "gcc" ? EMAIL_DOMAINS_GCC : EMAIL_DOMAINS_IN);
  for (let attempt = 0; attempt < 50; attempt++) {
    const style = rng.int(0, 4);
    const n = rng.chance(0.6) ? String(rng.int(1, 99)) : rng.chance(0.5) ? String(rng.int(1975, 2004)) : "";
    const local =
      style === 0 ? `${f}.${l}${n}` : style === 1 ? `${f}${l}${n}` : style === 2 ? `${f}${n || rng.int(10, 999)}` : style === 3 ? `${f}_${l}${n}` : `${l}.${f}${n}`;
    const email = `${local.replace(/^\.|\.$/g, "") || f}@${domain}`;
    if (!used.has(email)) {
      used.add(email);
      return email;
    }
  }
  const email = `${f}${l}${rng.digits(6)}@${domain}`;
  used.add(email);
  return email;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type Person = {
  first: string;
  last: string;
  name: string;
  gender: Gender;
  community: Community;
  city: string;
  state: string | null;
  country: string;
  region: Region;
  /** E.164 */
  phone: string;
  email: string;
  /** settings lists.languages key */
  language: string;
};

export type PersonPool = { phones: Set<string>; emails: Set<string>; nameCity: Set<string> };

export function newPersonPool(): PersonPool {
  return { phones: new Set(), emails: new Set(), nameCity: new Set() };
}

/**
 * A plausible person: region (weighted, or given), city, community, name, phone (in the city's country, a few
 * Gulf residents keep an Indian number), email and preferred language. Name + city is unique within the pool
 * unless `allowSameNameCity`, so "same name, same city" duplicate reviews appear only where a seeder wants them.
 */
export function makePerson(
  rng: Rng,
  pool: PersonPool,
  opts: { region?: Region; city?: string; community?: Community; gender?: Gender; allowSameNameCity?: boolean } = {},
): Person {
  const cityRow = opts.city ? cityByName(opts.city) : pickCity(rng, opts.region ?? rng.weighted(REGION_WEIGHTS));
  const region = cityRow.region;
  for (let attempt = 0; attempt < 100; attempt++) {
    const community = opts.community ?? communityFor(rng, region, cityRow);
    const gender = opts.gender ?? (rng.chance(0.68) ? "m" : "f");
    const n = personName(rng, community, gender);
    const key = `${n.name.toLowerCase()}|${cityRow.city.toLowerCase()}`;
    if (!opts.allowSameNameCity && pool.nameCity.has(key)) continue;
    pool.nameCity.add(key);
    const phoneCountry = region === "gcc" && community !== "arab" && rng.chance(0.04) ? "IN" : cityRow.country;
    return {
      ...n,
      gender,
      community,
      city: cityRow.city,
      state: cityRow.state,
      country: cityRow.country,
      region,
      phone: mobileNumber(rng, phoneCountry, pool.phones),
      email: emailFor(rng, n.first, n.last, region, pool.emails),
      language: languageFor(rng, community),
    };
  }
  throw new Error("Could not make a person with a unique name in that city");
}

/** A TagMango-style order id (24 hex characters, like a MongoDB ObjectId). */
export function tagmangoOrderId(rng: Rng, at: Date): string {
  return Math.floor(at.getTime() / 1000).toString(16).padStart(8, "0") + rng.hex(16);
}

/** A 12-digit UPI / IMPS UTR or an NEFT-style reference. */
export function utr(rng: Rng, mode: "upi_qr" | "bank_transfer" | string): string {
  if (mode === "upi_qr") return rng.pick(["3", "4", "5"]) + rng.digits(11);
  return rng.pick(["HDFC", "SBIN", "ICIC", "UTIB", "FDRL", "KKBK"]) + "N" + rng.digits(11);
}

/** Age band key weighted towards working professionals. */
export function ageBand(rng: Rng): string {
  return rng.weighted([
    ["18-24", 10],
    ["25-34", 30],
    ["35-44", 30],
    ["45-54", 18],
    ["55-64", 9],
    ["65+", 3],
  ]);
}

export type Occupation = { industry: string; designation: string; company?: string };

const OCCUPATIONS: readonly (readonly [Occupation, number])[] = [
  [{ industry: "business_owner", designation: "Owner" }, 18],
  [{ industry: "business_owner", designation: "Managing Director" }, 5],
  [{ industry: "business_owner", designation: "Founder" }, 5],
  [{ industry: "senior_manager", designation: "General Manager" }, 5],
  [{ industry: "senior_manager", designation: "Operations Manager" }, 4],
  [{ industry: "it_professional", designation: "Software Engineer" }, 8],
  [{ industry: "it_professional", designation: "Project Manager" }, 3],
  [{ industry: "healthcare_professional", designation: "Doctor" }, 4],
  [{ industry: "healthcare_professional", designation: "Pharmacist" }, 2],
  [{ industry: "healthcare_professional", designation: "Nurse" }, 2],
  [{ industry: "government", designation: "Government employee" }, 5],
  [{ industry: "freelancer", designation: "Freelance designer" }, 3],
  [{ industry: "freelancer", designation: "Content creator" }, 3],
  [{ industry: "other_professional", designation: "Accountant" }, 4],
  [{ industry: "other_professional", designation: "Lawyer" }, 2],
  [{ industry: "other_professional", designation: "Sales executive" }, 4],
  [{ industry: "teacher", designation: "Teacher" }, 8],
  [{ industry: "teacher", designation: "Lecturer" }, 2],
  [{ industry: "homemaker", designation: "Homemaker" }, 4],
  [{ industry: "student", designation: "Student" }, 6],
  [{ industry: "retired", designation: "Retired" }, 3],
];

const COMPANY_WORDS = ["Traders", "Textiles", "Supermarket", "Builders", "Travels", "Enterprises", "Pharma", "Motors", "Bakers", "Agencies", "Electronics", "Logistics", "Jewellers", "Hardware"];

export function occupation(rng: Rng, person: Pick<Person, "last" | "first" | "region">): Occupation {
  const o = rng.weighted(OCCUPATIONS);
  if (o.industry !== "business_owner") return o;
  const word = rng.pick(COMPANY_WORDS);
  const base = /^[A-Z]( [A-Z])?$/.test(person.last) ? person.first : person.last;
  const company = person.region === "gcc" ? `${base} ${word} LLC` : `${base} ${word}`;
  return { ...o, company };
}
