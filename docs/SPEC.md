# Edapt CRM: Requirements and Build Spec

Oct 13, 2026 · @Umer Abdussalam

## The big idea

2,000 new paid customers a month across 5 salespeople is about 18 new buyers per person per working day, before counting a single lead. So this CRM is not a contact book. It is Edapt's attention allocator: it decides who deserves a human, when, and with which offer.

1. **A ladder, not a funnel.** Every customer has a current rung and a next likely rung. Lifetime value is built by climbing, so every contact page shows the next rung.
2. **The machine captures, people enrich.** Most buyers pay on TagMango without talking to anyone. They enter automatically; salespeople add judgment only where it pays.
3. **Three scores, one grade.** Fit (who they are), Readiness (what is in their head) and Value (what they have done) roll up into one Edapt Score and an A to D grade.
4. **The First Door is stored forever.** People reach Edapt through YouTube, an MLA program, a workshop ad or a delegation. Knowing which door produces valuable customers beats knowing which ad produces cheap leads.
5. **Referrers are worth more than their own spend.** Each contact shows network value, the revenue from people they brought in, next to their own LTV.
6. **Trust in Umer and trust in Edapt are measured apart.** The Beyond-Umer revenue share tracks money from people who barely know Umer. When it rises, the brand is selling without its founder.

&#91;embedded content: the Edapt ladder · 4 rungs, 2 side groups\]

Workshop buyers enter at Rung 1. The CRM's job is to move them up, and to offer delegation alumni Premium directly.

## Scope of v1

Version 1 records and alerts. It does not message customers; the customer-experience module comes later on the same data.

**In version 1**

- Every revenue line: workshops, Applied AI Mastery, The AI Office, consulting, B2B and constituency programs, plus about 400 delegation customers kept as a closed legacy line.
- Individuals and B2B accounts (schools, constituency offices, partner firms), all entering as leads.
- INR as the base currency, with AED entry.
- A web app built for laptops that works comfortably on a phone.

**Later**

- WhatsApp and email follow-ups sent from the CRM.
- The customer-experience module.
- Call recording, bank statement matching, and sending purchase data back to Meta.

| Role | People | Sees | Can do |
| --- | --- | --- | --- |
| Admin | Umer | Everything | Settings, scoring weights, imports, exports |
| Manager | To be named | All contacts | Reassign owners, verify payments, team dashboard |
| Sales | About 5, Kerala and Dubai | Own contacts plus the unassigned pool | Add leads, log calls, rate, record payments |
| Support | About 5 | All contacts | Log support issues and notes without changing the owner |

## Capture: every way in

Four channels flow in automatically, four need a 30-second manual entry, and old data comes through the import wizard.

| Channel | What it brings | How it enters | Phase |
| --- | --- | --- | --- |
| TagMango checkout | Purchases, plus checkouts started or failed | Automatic: TagMango order webhook | 3 |
| WhatsApp API (Libromi) | New chats and replies | Automatic: Libromi API, or via Pabbly | 3 |
| Meta lead forms | Ad leads with their form answers | Automatic: Pabbly Connect into the CRM | 3 |
| Website forms | Call-back requests, such as The AI Office | Automatic: form webhook or Pabbly | 3 |
| WhatsApp Business app on phones | Chats on salespeople's phones | Manual: Quick Add | 1 |
| Phone calls on company mobiles | Inbound and outbound calls | Manual: Quick Add and call log | 1 |
| Bank transfer and UPI QR | Direct payments | Manual: Record payment with UTR and screenshot, then verified | 1 |
| Events, MLA programs, walk-ins | Attendees and referrals | Manual, or an attendance sheet through Import | 1 and 2 |
| Old data | TagMango history, Zoho, sheets, docs | Import wizard | 2 |

**Abandoned checkouts are the hottest leads Edapt has.** TagMango reports when a payment starts and when it fails, not only when it completes ([TagMango webhooks](https://docs.tagmango.com/docs/webhooks/order-created-all)). Anyone who started paying and has no completed order an hour later becomes a call task at the top of Today.

**Referrals and self-ratings arrive with the order.** Each TagMango order carries the affiliate's name and phone when it came through an affiliate link, plus any custom checkout fields. That feeds the referral score and self-ratings with zero typing.

**Route every new enquiry to the Libromi number.** Ads and website buttons should open the API number, which connects to other systems in real time through its REST API, Pabbly, Zapier or Make ([Libromi](https://exhibitors.gitex.com/gitex-global-2024/Exhibitor/ExbDetails/01-libromi)). Chats on the phone app are invisible to the company and leave when a salesperson leaves.

## One person, one record

The phone number is the identity key: every channel, import and purchase attaches to one contact per normalised number.

1. **Normalise every number** to international format with a standard phone library, defaulting to India. TagMango sends the dial code separately, so it is joined back on. A UAE number written as 05X XXX XXXX becomes +971 5X XXX XXXX.
2. **Match in this order:** exact phone, then exact email. Same name in the same city is only flagged for review, never merged automatically.
3. **Extra numbers and emails** are stored as alternates on the same contact, and they match too.
4. **A merge keeps the oldest First Door, the first owner, and every purchase and note.** Nothing is deleted, every merge is logged, and any merge can be undone.
5. **The duplicate check runs while typing.** Entering a known number in Quick Add shows the existing contact and its owner before anything is saved. This ends the ownership clashes Zoho was brought in to prevent.

## Importing the 50,000 old records

About 50,000 records sit in TagMango, Zoho CRM and sheets, with heavy overlap between them. The first number the import gives you is Edapt's true count of unique customers.

**Import order** (payment records first, so they form the backbone)

1. TagMango customers and order history: the most reliable source, because every row is a real payment.
2. Zoho CRM: owners and notes, so today's salesperson assignments carry over.
3. The delegation customer list (about 400), tagged Legacy: Delegation.
4. MLA and constituency program sheets, tagged by program.
5. Everything else: old sheets and docs.

**The wizard, in six steps**

1. Upload a CSV, an Excel file or a doc.
2. AI proposes the column mapping; for docs, it pulls rows out of free text. You confirm.
3. Clean: phones normalised, names in proper case, emails in lower case, dates and amounts parsed, currency detected.
4. Match against existing contacts using the rules above.
5. Review: counts of New, Will merge, Conflict and Invalid, with one-click fixes for conflicts.
6. Commit. Each import is a batch that can be undone in one click, and every row keeps its raw original.

Imported contacts take their First Door from the source: the delegation list sets it to Delegation, a constituency sheet to MLA program. Missing fields stay empty and are never guessed.

**Delegation customers are a priority pool, not an archive.** They paid for international trips and trusted Edapt with their time abroad. Their product closed by Edapt's choice, not theirs, so they surface first for The AI Office and premium programs.

## Labels: Channel, First Door, Campaign

Every contact carries three labels that answer three different questions. Salespeople pick them from dropdowns; the lists are edited in Settings.

| Label | Question it answers | Changes? | Options |
| --- | --- | --- | --- |
| Channel | How did this enquiry reach us? | A new value with every enquiry | WhatsApp API, WhatsApp app, Meta lead form, TagMango checkout, Website form, Phone call, Walk-in or event, Import |
| First Door | How did they first come to know Edapt or Umer? | Set once, never overwritten | YouTube, Meta ad, Workshop or webinar, MLA or constituency program, Delegation, The AI Office, Book or keynote, Referral, School partnership, Business partner, Search or website, Other |
| Campaign | Which campaign, program or event exactly? | Per enquiry | Koduvally AI Literacy Mission, Buddhi Yatra Malappuram, AI Office Dubai October 2026, Claude Mastery Meta ads |
| Tags | Anything else worth filtering by | Any time | Legacy: Delegation, B2B, VIP, Mentor prospect |

After 90 days, LTV by First Door shows which doors produce valuable customers, so MLA programs and YouTube are judged on revenue, not reach.

## Customer profile

Only four fields are needed to save a contact: phone, name, Channel and First Door. Everything else is added when known, or calculated by the system.

| Field | Input | Filled by | Required |
| --- | --- | --- | --- |
| Phone | Phone, normalised | System or sales | Yes |
| Name | Text | System or sales | Yes |
| Channel, First Door | Dropdowns | System or sales | Yes |
| Alternate phones, email | Text | System or sales | No |
| Contact type | Individual or Business | Sales | No, default Individual |
| Organisation | Link to a school, office or company | Sales | For B2B |
| City, state, country | Search dropdown | System (TagMango country) or sales | No |
| Preferred language | Malayalam, English, Hindi, Arabic, Tamil, Other | Sales | No |
| Age band | 18 to 24, 25 to 34, 35 to 44, 45 to 54, 55 to 64, 65+ | Sales or self-rating | No |
| Industry or role | Dropdown (see scoring) | Sales | No |
| Designation, company name | Text | Sales | No |
| Spending power | Bands 1 to 5 | Sales | No |
| AI knowledge | Scale 0 to 5 | Sales or self-rating | No |
| Umer familiarity | Scale 0 to 5 | Sales or self-rating | No |
| Gut rating | 1 to 5 stars | Sales | No |
| Sales notes | Free text for anything the scales miss | Sales | No |
| Referred by | Link to another contact | System (TagMango affiliate) or sales | No |
| Marketing consent | Yes or no, with date | System or sales | No |
| Tags | Multi-select | Sales | No |
| Owner, first owner | Team members | System | Automatic |

**Calculated, read-only:** LTV, purchase count, product families bought, first and last purchase, average gap, expected next purchase, repeat probability, Fit, Readiness, Value, Edapt Score, grade and network value.

Preferred language doubles as the expansion meter. Today nearly every customer speaks Malayalam, so the share who don't tracks the move beyond the Malayali market.

## Lifecycle stages

The system moves contacts through six of the eight stages by itself; salespeople set only Qualified and Lost.

&#91;embedded content: lifecycle · 8 stages, 2 set by hand\]

Checkout buyers jump from New straight to First Purchase without a salesperson touching them.

Lost needs a reason from a short list: price, timing, not interested, wrong number, bought elsewhere, other. Lost reasons show on the dashboard as product feedback. Any new enquiry or payment pulls a Dormant or Lost contact back into the right stage automatically.

## Ownership and handover rules

Each contact has exactly one owner at a time, the first owner is recorded forever, and every change is logged with a reason.

1. **New leads are assigned automatically.** GCC numbers go to the Dubai team, all others to the Kerala team, then round robin among active salespeople in that team.
2. **Returning contacts go to their current owner.** A known customer's new enquiry stays with the person who already holds the relationship.
3. **The first owner never changes.** "Who handled them first" survives every reassignment.
4. **Use it or lose it.** An open lead with no logged interaction for 7 days returns to the pool and alerts the manager. Customers never expire this way.
5. **Only the manager or admin reassigns.** Salespeople can request a transfer; they cannot take a contact.
6. **Sales credit follows real contact.** A purchase is credited to the owner if they logged an interaction in the 30 days before it. Otherwise it counts as self-serve. The manager can adjust credit.
7. **Support never owns.** Support logs interactions on any contact without changing the owner.
8. **When someone leaves,** all their contacts move to the manager in one action, with full history.

Rule 6 gives Edapt a number it has never had: assisted versus self-serve revenue. It shows whether a sales call actually changes what a customer spends.

## Purchases, payments and LTV

LTV counts cash actually received, in INR, net of refunds. List prices, unpaid balances and unverified transfers never inflate it.

**Every purchase records** the product, list price, discount, final amount, currency, INR value, date, payment mode (TagMango, bank transfer, UPI QR, cash, other), reference (TagMango order ID or UTR, unique), status, credited salesperson, B2B organisation if any, and a proof upload.

| Situation | How it is handled |
| --- | --- |
| TagMango order | Created automatically, verified by default, order ID as the reference |
| Bank transfer or UPI | Recorded with UTR and screenshot as Unverified; counts toward LTV only after the manager verifies it |
| Part payment or EMI | One purchase with an instalment schedule; each instalment has a due date and its own status |
| Refund | A negative payment with a reason; LTV drops by that amount |
| AED payment | AED amount stored with its INR value at that month's rate, saved on the payment so past LTV never shifts |
| USD (The AI Office pricing) | Add USD as a third currency in Settings, no code change |
| B2B deal | Linked to both the organisation and the person who signed |

```latex
\text{LTV} = \sum \text{verified payments (INR)} - \sum \text{refunds (INR)}
```

```latex
\text{Network value} = \sum \text{LTV of the contacts they referred}
```

Duplicate references are rejected, so a TagMango order or a UTR can never be counted twice.

## Rating scales

Salespeople rate four things in under 20 seconds on anchored scales, so two people rating the same customer land on the same number.

**AI knowledge**

| Level | What you hear on the call |
| --- | --- |
| 0 | Has never used an AI tool |
| 1 | Tried ChatGPT or similar a few times |
| 2 | Uses AI now and then for simple tasks |
| 3 | Uses AI every week in work or business |
| 4 | Power user: several tools, builds own workflows |
| 5 | Builds with AI (automations, agents, apps) or works in tech |

**Umer familiarity**

| Level | What you hear on the call |
| --- | --- |
| 0 | Does not know Umer |
| 1 | Knows the name or saw an ad |
| 2 | Has watched a few of his videos |
| 3 | Watches regularly and can recall his ideas |
| 4 | Follows closely: read his book, or attended his session or keynote |
| 5 | Personal connection: has met him or is in his network |

**Spending power** (pick by stated income, or judge from role, company, location and past purchases)

| Band | India, yearly income | GCC, monthly income |
| --- | --- | --- |
| 1 Low | Under ₹3 lakh | Under AED 5,000 |
| 2 Lower-middle | ₹3 to 8 lakh | AED 5,000 to 10,000 |
| 3 Middle | ₹8 to 20 lakh | AED 10,000 to 20,000 |
| 4 Upper-middle | ₹20 to 50 lakh | AED 20,000 to 40,000 |
| 5 High | Over ₹50 lakh | Over AED 40,000 |

**Gut rating and notes.** A 1 to 5 star call on overall potential, plus a free-text note for what the scales miss, such as "runs three supermarkets, wants AI for stock control".

**Self-rating at the door.** Nobody can hand-rate 2,000 buyers a month. Two optional one-tap questions in the WhatsApp welcome message, or as TagMango custom fields, ask how they first heard of Edapt and how well they know Umer. Self-ratings fill the fields; a salesperson's rating overrides them.

Every rating is kept with who gave it and when; the contact shows the latest.

## Scoring formulas

Three scores from 0 to 100 roll up into one Edapt Score and an A to D grade, recalculated every night and after every change.

&#91;embedded content: score tree · 12 inputs, 3 scores, 1 grade\]

Leads are judged on Fit and Readiness alone; once someone pays, what they have done carries half the score.

```latex
\text{Edapt}_{\text{lead}} = 0.5\,F + 0.5\,R + G
```

```latex
\text{Edapt}_{\text{customer}} = 0.25\,F + 0.25\,R + 0.5\,V + G
```

F is Fit, R is Readiness, V is Value and G is the gut adjustment: 1 star -10, 2 stars -5, 3 stars or unrated 0, 4 stars +5, 5 stars +10. The result is held between 0 and 100.

**Grade:** A is 75 and above, B is 60 to 74, C is 40 to 59, D is under 40.

| Score | Input | Max | Default points |
| --- | --- | --- | --- |
| Fit | Spending power | 25 | Band 1: 5, 2: 10, 3: 15, 4: 20, 5: 25, unknown: 10 |
| Fit | Industry or role | 25 | Business owner 25, senior manager 22, IT or healthcare professional 18, government or freelancer 15, other professional 12, retired 10, teacher or homemaker 8, student 5, unknown 10 |
| Fit | Age band | 25 | 35 to 44: 25, 45 to 54: 22, 25 to 34: 18, 55 to 64: 15, 65+: 10, 18 to 24: 8, unknown: 12 |
| Fit | Location | 25 | GCC 25, rest of world 20, Kerala cities and Indian metros 18, rest of Kerala 15, rest of India 12, unknown 12 |
| Readiness | Umer familiarity | 40 | 8 points per level; unknown counts as level 1 |
| Readiness | AI knowledge | 30 | 0: 10, 1: 20, 2: 30, 3: 30, 4: 24, 5: 14, unknown: 15 |
| Readiness | Recent interest | 30 | Enquiry, chat or purchase in the last 7 days: 30, 30 days: 20, 90 days: 10, older: 0 |
| Value | Money (LTV) | 25 | Under ₹1,000: 5, ₹1,000 to 5,000: 10, ₹5,000 to 20,000: 15, ₹20,000 to 50,000: 20, over ₹50,000: 25 |
| Value | Frequency | 20 | 1 purchase: 5, 2: 10, 3: 14, 4 to 5: 17, 6 or more: 20 |
| Value | Breadth (product families) | 20 | 1: 5, 2: 13, 3 or more: 20 |
| Value | Referrals (paying customers brought) | 20 | 1: 10, 2: 15, 3 or more: 20 |
| Value | Recency | 15 | Last purchase within 90 days: 15, 91 to 180: 10, 181 to 365: 5, older: 0 |

**Worked examples**

| Contact | Fit | Readiness | Value | Edapt Score | Grade |
| --- | --- | --- | --- | --- | --- |
| GCC business owner, 35 to 44, band 5, Umer 4, AI 3, chatted this week; ₹1.2 lakh over 4 purchases in 3 lines, last one 2 months ago, 2 referrals | 100 | 92 | 92 | 94 | A |
| New lead: Kerala-city business owner, 35 to 44, band 4, Umer 3, AI 2, enquired today | 88 | 84 | Not used | 86 | A |
| Workshop buyer, nothing rated yet, rest of Kerala, one ₹699 purchase 5 days ago | 47 | 53 | 30 | 40 | C |
| New lead: student, 18 to 24, band 1, rest of India, Umer 0, AI 1, enquired 2 months ago | 30 | 30 | Not used | 30 | D |

**AI knowledge is a curve, not a ladder.** Curious beginners and regular users buy most; true builders rarely buy beginner products. Level 5 contacts are better invited as mentors or affiliates.

**Breadth and referrals weigh as much as frequency.** Edapt's best customers buy across lines and bring others in. A customer who climbs three rungs outscores one who repeats the same workshop many times.

**Every weight is a starting hypothesis.** After 90 days, a calibration report shows conversion and repeat rates by score band and by each input. Weights change in Settings with no code change, so the data gets a vote.

## Repeat purchase and revenue forecast

Every customer gets an expected next purchase date and a repeat probability, which add up to a 90-day revenue forecast.

| Metric | How it is calculated |
| --- | --- |
| Days since last purchase | Today minus the last paid purchase date |
| Average gap | Mean days between consecutive purchases, for customers with 2 or more |
| Expected next purchase | Last purchase plus the average gap. One-time buyers use Edapt's median gap between first and second purchase |
| At risk | Today is more than 30 days past the expected next purchase |
| Repeat probability (90 days) | Share of past customers in the same cohort who bought again within 90 days. Cohort = first product family and number of purchases so far |
| Expected 90-day revenue | Repeat probability times the price of the next best offer |
| 90-day forecast | Sum of expected 90-day revenue across all customers |

Cohorts are rebuilt every night from Edapt's own history, which the TagMango import provides from day one. A cohort with fewer than 30 customers falls back to the company-wide rate.

**Next best offer** (rules editable in Settings)

| Where the customer is | Next best offer |
| --- | --- |
| Free only: YouTube, webinar, MLA program | An entry workshop at ₹699 to ₹999 |
| One workshop | A workshop on a different topic, or Applied AI Mastery if Fit is 60 or more |
| Business owner, any workshop | AI Agents for Business, then The AI Office for GCC owners |
| Applied AI Mastery graduate | The AI Office or advanced workshops |
| The AI Office member | Renewal, and an ask for referrals |
| Delegation alumni | The AI Office and premium programs |
| AI knowledge level 5 | A mentor or affiliate invitation |

## Alerts and the Today queue

Each salesperson starts the day with one ranked list, capped at 40 actions by default. Overdue follow-ups sit on top; customers are ranked by expected revenue, leads by Edapt Score. Every row shows why it is there.

| Alert | Trigger | Goes to | Where |
| --- | --- | --- | --- |
| Abandoned checkout | TagMango payment started or failed, no completed order within 1 hour | Owner, or the pool | Top of Today |
| Hot lead | A grade A lead enquires | Owner and manager | In-app and email |
| New lead | A lead is assigned | Owner | In-app |
| Untouched lead | No interaction 24 hours after assignment | Owner; manager at 48 hours | In-app |
| Follow-up due | The follow-up date arrives | Owner | Today |
| Due for next rung | Within 7 days of the expected next purchase | Owner | Today |
| At risk | 30 days past the expected next purchase | Owner | Today |
| Instalment due | An EMI is due in 3 days or overdue | Owner and manager | In-app |
| Unverified payment | A manual payment unverified after 2 days | Manager | Email |
| New advocate | Someone they referred makes a first payment | Owner of the referrer | Today: call to thank |
| VIP gone quiet | A grade A customer with no activity for 120 days | Owner and Umer | Email digest |
| Lead released | 7 days with no interaction on an open lead | Manager | In-app |

A daily digest goes out at 8:30 am in each user's own time zone, and a weekly summary goes to Umer every Monday.

## Screens

Ten screens cover everything. The five the team uses all day are designed for the phone first, and the app can be installed on a phone's home screen like a normal app.

| Screen | What it does | Used by | Phone first |
| --- | --- | --- | --- |
| Today | The ranked queue, with one-tap Call and WhatsApp buttons | Sales, support | Yes |
| Quick Add | Phone, name, Channel, First Door, with the live duplicate check | Sales, support | Yes |
| Contact page | Grade, scores, owner and stage on top; a timeline of every touch; tabs for purchases, ratings, referrals and details | Everyone | Yes |
| Log interaction | Type, outcome chips, next follow-up chips (tomorrow, 3 days, 1 week), a note. Under 30 seconds | Sales, support | Yes |
| Rate customer | The four scales with their anchors, gut stars, notes, and a live score preview | Sales | Yes |
| Record payment | Product, amount, INR or AED, mode, UTR, proof upload, instalments | Sales, manager | No |
| Contacts list | Search and filters by grade, stage, door, campaign, owner, product, country, language and tag; saved views | Everyone | No |
| Import | The six-step wizard | Admin | No |
| Dashboard | The growth cockpit | Umer, manager | No |
| Settings | Users, teams, assignment rules, products and rungs, scoring weights, currency rates, alert thresholds, dropdown lists | Admin | No |

Tapping Call opens the phone dialler. When the salesperson comes back to the app, the Log interaction sheet is already open, so logging is never forgotten.

## Dashboard: the growth cockpit

The cockpit answers one question each week: is Edapt growing the right way, not just growing?

| Metric | What it tells you |
| --- | --- |
| Revenue this month vs last, by product family | Where the money is coming from now |
| Leads and conversion by Channel | Which channels convert, not just which are busy |
| LTV by First Door | Which doors bring valuable customers over time |
| Repeat rate and median days from first to second purchase | How strong the ladder is |
| Rung moves this month | How many customers climbed, and from which rung |
| 90-day revenue forecast | Money likely to arrive from existing customers |
| At-risk pool | Count and expected value of customers past their expected date |
| Abandoned checkouts recovered | Count recovered and revenue saved |
| Assisted vs self-serve revenue | Whether sales calls change what customers spend |
| Team view | First-response time, contacts handled, conversion and assisted revenue per person |
| Beyond-Umer revenue share | Share of revenue from customers at Umer familiarity 0 to 2. Rising means the brand sells without its founder |
| Language mix | Share of customers whose preferred language is not Malayalam: the expansion meter |
| Referral leaderboard | Top advocates and the revenue their network brought |
| Data health | Unrated contacts, unverified payments, possible duplicates |

## Data model

Fifteen tables in one Postgres database. Claude Code can generate the schema straight from this list.

| Table | Holds | Key fields |
| --- | --- | --- |
| users | Team members | name, email, role (admin, manager, sales, support), team (Kerala, Dubai), timezone, active |
| contacts | One row per person | phone\_e164 (unique), name, email, alt\_phones, type, organisation\_id, city, state, country, language, age\_band, industry, designation, spending\_band, ai\_level, umer\_level, gut\_stars, sales\_notes, first\_door, first\_campaign, referred\_by\_id, consent, stage, owner\_id, first\_owner\_id, tags, plus the calculated columns below |
| organisations | B2B accounts | name, kind (school, constituency office, company, partner), city, country |
| enquiries | Every inbound touch | contact\_id, channel, campaign, product\_interest, raw\_payload (json), received\_at, status |
| interactions | Calls, chats, meetings, notes, support issues | contact\_id, user\_id, type, outcome, summary, next\_follow\_up\_at |
| ratings | Rating history | contact\_id, rated\_by (user or self), ai\_level, umer\_level, spending\_band, gut\_stars, notes, created\_at |
| products | Catalogue | name, family, rung, list\_price, currency, active |
| purchases | Orders | contact\_id, organisation\_id, product\_id, amount, currency, fx\_rate, amount\_inr, purchased\_at, mode, reference (unique), status, credited\_user\_id, source (tagmango, manual, import) |
| payments | Instalments and refunds | purchase\_id, kind (payment, refund), amount, currency, amount\_inr, due\_at, paid\_at, mode, reference, verified\_by, proof\_url |
| ownership\_log | Every owner change | contact\_id, from\_user, to\_user, reason, changed\_by, changed\_at |
| tasks | Follow-ups and alerts | contact\_id, user\_id, type, reason, due\_at, status |
| import\_batches | Each import | file\_name, source, uploaded\_by, counts, status |
| import\_rows | Staged rows | batch\_id, raw (json), mapped (json), match\_result, contact\_id |
| settings | Weights, rules, lists, currency rates | key, value (json) |
| audit\_log | Who changed what | table\_name, row\_id, field, old\_value, new\_value, user\_id, changed\_at |

**Calculated columns on contacts:** ltv\_inr, purchase\_count, family\_count, first\_purchase\_at, last\_purchase\_at, avg\_gap\_days, next\_expected\_at, repeat\_prob\_90d, expected\_90d\_inr, next\_offer, fit, readiness, value, edapt\_score, grade, network\_value\_inr.

Webhook handlers must be idempotent: the same TagMango order or WhatsApp message arriving twice changes nothing, guarded by the unique reference.

## Tech stack, hosting and cost

The CRM runs as a Next.js app on Vercel, with Supabase in its Mumbai region as database, login and file store. The base cost is about USD 45 a month.

&#91;embedded content: architecture · 5 sources, 1 database\]

Three of the five sources arrive without anyone typing; the scores and alerts are rebuilt overnight from the same database.

| Piece | Tool | Why this one | Monthly cost |
| --- | --- | --- | --- |
| App: screens and webhook endpoints | Next.js | One codebase for everything; widely used, so Claude Code and online help cover it well | Free, open source |
| Hosting | [Vercel](https://vercel.com/pricing) Pro | Deploys automatically on every change; the free Hobby plan is for non-commercial use only | USD 20, one developer seat |
| Database, login, file uploads | [Supabase](https://supabase.com/pricing) Pro, [Mumbai region](https://supabase.com/docs/guides/platform/regions) | Postgres with role-based security, daily backups kept 7 days, never pauses | From USD 25 |
| Code | GitHub, private repository | Full history; any change can be rolled back | Free |
| Bridge for Meta lead forms and website forms | Pabbly Connect, Zapier or Make | A no-code link where a direct webhook is not offered | Existing plan, if any |
| AI mapping during imports | Claude API | Maps messy columns and pulls rows out of docs | Usage-based, small |
| Email digests | A transactional email service | Daily and weekly digests | Low at this volume |

**Data hygiene that slows nobody down**

- Data stays in India, in Supabase's Mumbai region.
- Salespeople see only their own contacts and the pool.
- Only the admin can export, and every export is logged.
- Daily backups are kept for 7 days.
- A consent field on every contact keeps Edapt ready for India's DPDP rules and the UAE's data protection law.

**Accounts to open before Phase 1**

- [ ] Claude Code set up on your laptop
- [ ] GitHub account with a private repository
- [ ] Supabase account on Pro, project in South Asia (Mumbai)
- [ ] Vercel account on Pro, linked to GitHub
- [ ] Anthropic Console API key, for import mapping
- [ ] TagMango API key, from Automations, Platform Integrations
- [ ] Libromi API and webhook access
- [ ] Pabbly Connect, Zapier or Make, if not already in use
- [ ] A subdomain for the CRM, such as crm.yourdomain

## Build plan for Claude Code

Six phases, each usable on its own: the team starts entering leads after Phase 1 while the rest is built. This doc goes into the repository as the project brief (CLAUDE.md), so Claude Code always works from the same spec.

&#91;embedded content: roadmap · 6 phases, 6 gates\]

Phase 1 replaces Zoho for new leads; every later phase adds to a CRM the team is already using.

**What each phase builds**

- **Phase 0, Setup.** The accounts in the checklist above, the repository, the Supabase project, Vercel linked.
- **Phase 1, Core.** Contacts, Quick Add with the duplicate check, contact page, interactions, the Today list of follow-ups, roles, ownership and auto-assign rules, products, purchases and payments (INR and AED, instalments, refunds, verification).
- **Phase 2, Data in.** The import wizard, then TagMango history, Zoho, the delegation list, program sheets and other sheets, in that order.
- **Phase 3, Pipes.** TagMango order webhooks (purchases, abandoned checkouts, affiliates), the Libromi API connection, Meta lead forms and website forms through Pabbly.
- **Phase 4, Brain.** The rating screen, the three scores, Edapt Score and grade, repeat metrics, next best offer, every alert and the daily digest.
- **Phase 5, Cockpit.** The dashboard, the calibration report and the Beyond-Umer share.

**Later:** the customer-experience module, WhatsApp follow-ups through Libromi, sending purchases back to Meta so ads find more buyers like the best ones, cloud telephony, and bank statement matching.

## Decisions still open

Eight decisions are open. Each has a default, so the build can start without waiting.

| Decision | Default until you change it |
| --- | --- |
| Who is the manager with reassign and payment-verify rights? | Umer |
| How are the 5 sales and 5 support people split between Kerala and Dubai? | GCC leads to Dubai, all others to Kerala |
| Does sales credit affect incentives or pay? | Tracked for reporting only |
| Days before an untouched lead returns to the pool | 7 |
| Who verifies bank and UPI payments? | The manager |
| Where do the self-rating questions go? | The WhatsApp welcome message, so checkout stays fast |
| Spending-power bands and score weights | As in this spec, reviewed after 90 days |
| Current product list and prices, including Applied AI Mastery | Needed before Phase 1 |

## Sources

- [TagMango order webhook: statuses, affiliate and custom fields](https://docs.tagmango.com/docs/webhooks/order-created-all)
- [Pabbly guide: TagMango New Order trigger and API key location](https://www.pabbly.com/automate-tagmango-customer-addition-to-kit-sequence-using-pabbly-connect/)
- [Libromi: REST API and Pabbly, Zapier, Make integrations](https://exhibitors.gitex.com/gitex-global-2024/Exhibitor/ExbDetails/01-libromi)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase regions](https://supabase.com/docs/guides/platform/regions)
- [Vercel pricing](https://vercel.com/pricing)
