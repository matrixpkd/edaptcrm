import { describe, expect, it } from "vitest";
import { extractRowsFromText, fieldForHeader, heuristicMapping, normalizeHeader, sniffValues } from "@/lib/import/heuristic";
import { csvCell } from "@/lib/import/csv";

const cols = (headers: string[], samples: Record<string, string[]> = {}) => headers.map((header) => ({ header, samples: samples[header] ?? [] }));

describe("import heuristic mapping", () => {
  it("normalises headers", () => {
    expect(normalizeHeader("Contact No.")).toBe("contact no");
    expect(normalizeHeader("customer_name")).toBe("customer name");
    expect(normalizeHeader("orderID")).toBe("order id");
  });

  it("maps a TagMango orders export", () => {
    const m = heuristicMapping(
      cols(["Order ID", "Customer Name", "Email", "Dial Code", "Phone", "Mango", "Amount", "Currency", "Order Date", "Affiliate Name", "Affiliate Phone", "City"]),
    );
    expect(m).toEqual({
      "Order ID": "order_id",
      "Customer Name": "name",
      Email: "email",
      "Dial Code": "dial_code",
      Phone: "phone",
      Mango: "product",
      Amount: "amount",
      Currency: "currency",
      "Order Date": "purchased_at",
      "Affiliate Name": "referrer_name",
      "Affiliate Phone": "referrer_phone",
      City: "city",
    });
  });

  it("maps a Zoho CRM export: owner, first + last name, notes, lead source", () => {
    const m = heuristicMapping(
      cols(["Contact Owner", "First Name", "Last Name", "Mobile", "Phone", "Email", "Mailing City", "Description", "Lead Source", "Date of Birth", "Annual Revenue", "Created Time"]),
    );
    expect(m["Contact Owner"]).toBe("owner");
    expect(m["First Name"]).toBe("name");
    expect(m["Last Name"]).toBe("name");
    expect(m.Mobile).toBe("phone");
    // a second phone column becomes the alternate
    expect(m.Phone).toBe("alt_phone");
    expect(m["Mailing City"]).toBe("city");
    expect(m.Description).toBe("notes");
    expect(m["Lead Source"]).toBe("first_door");
    expect(m["Date of Birth"]).toBe("ignore");
    expect(m["Annual Revenue"]).toBe("ignore");
    // a record's created time is not a purchase date when the file has no amounts: it dates the enquiry
    expect(m["Created Time"]).toBe("enquired_at");
  });

  it("knows the synonyms from the spec", () => {
    const expected: Record<string, string> = {
      "WhatsApp Number": "phone",
      "Contact no": "phone",
      "Full Name": "name",
      "Price": "amount",
      "Paid": "amount",
      "Purchase Date": "purchased_at",
      "Course": "product",
      "Transaction ID": "order_id",
      UTR: "order_id",
      "Lead Owner": "owner",
      Salesperson: "owner",
      Remarks: "notes",
      "Country Code": "dial_code",
      Program: "campaign",
      Affiliate: "referrer_name",
      "Payment Method": "payment_mode",
      "Opt In": "consent",
      Designation: "designation",
      "Company Name": "company_name",
      "Preferred Language": "language",
      "Age Group": "age_band",
      Occupation: "industry",
      Tags: "tags",
      State: "state",
      Country: "country",
    };
    for (const [h, f] of Object.entries(expected)) expect(fieldForHeader(h), h).toBe(f);
  });

  it("uses each single-value field once", () => {
    const m = heuristicMapping(cols(["Email", "Email Address", "City", "Town"]));
    expect(m).toEqual({ Email: "email", "Email Address": "ignore", City: "city", Town: "ignore" });
  });

  it("an unknown date column is a purchase date only when the file has amounts", () => {
    // an attendance date is when the person was in touch, not a purchase
    expect(heuristicMapping(cols(["Name", "Attended On"], { "Attended On": ["2025-08-15", "2025-08-16"] }))["Attended On"]).toBe("enquired_at");
    expect(heuristicMapping(cols(["Name", "When"], { When: ["2025-08-15", "2025-08-16"] })).When).toBe("ignore");
    expect(heuristicMapping(cols(["Amount", "When"], { When: ["2025-08-15", "2025-08-16"] })).When).toBe("purchased_at");
  });

  it("dates the enquiry from created, registration and event date columns", () => {
    const m = heuristicMapping(cols(["Phone", "Registration Date", "Lead Created Time", "Date of Birth"]));
    expect(m).toMatchObject({ "Registration Date": "enquired_at", "Lead Created Time": "ignore", "Date of Birth": "ignore" });
    expect(fieldForHeader("Event Date")).toBe("enquired_at");
    expect(fieldForHeader("Created At")).toBe("enquired_at");
    // in a file of orders, the created time is the order time
    expect(fieldForHeader("Created At", { hasAmount: true })).toBe("purchased_at");
  });

  it("falls back to what the values look like for unknown headers", () => {
    expect(sniffValues(["anil@example.com", "x@y.in", ""])).toBe("email");
    expect(sniffValues(["9847012345", "+971 50 123 4567", "98470 12345"])).toBe("phone");
    expect(sniffValues(["12 Oct 2025", "13/10/2025"])).toBe("purchased_at");
    expect(sniffValues(["₹999", "Rs 1,200"])).toBe("amount");
    expect(sniffValues(["Kochi", "Dubai"])).toBeNull();
    const m = heuristicMapping(cols(["Column 1", "Column 2", "Column 3"], {
      "Column 1": ["Anil", "Meera"],
      "Column 2": ["9847012345", "9746001122"],
      "Column 3": ["a@b.com", "c@d.com"],
    }));
    expect(m).toEqual({ "Column 1": "ignore", "Column 2": "phone", "Column 3": "email" });
  });
});

describe("import heuristic doc rows", () => {
  it("turns every line with a phone number (or email) into a row", () => {
    const text = [
      "Edapt delegation 2024 - Dubai trip participants",
      "",
      "1. Thomas George – 9847123456 – Kottayam",
      "2. Lakshmi Menon, 9447 654 321, lakshmi.menon@example.com",
      "3) Abdul Rahman : +971 55 765 4321",
      "Write to info@edapt.in",
      "Contact Umer for anything about the trip.",
    ].join("\n");
    const rows = extractRowsFromText(text);
    expect(rows).toEqual([
      { Name: "Thomas George", Phone: "+919847123456", Email: "", Details: "Kottayam" },
      { Name: "Lakshmi Menon", Phone: "+919447654321", Email: "lakshmi.menon@example.com", Details: "" },
      { Name: "Abdul Rahman", Phone: "+971557654321", Email: "", Details: "" },
      { Name: "Write to", Phone: "", Email: "info@edapt.in", Details: "" },
    ]);
  });

  it("maps the doc rows straight onto the fields", () => {
    expect(heuristicMapping(cols(["Name", "Phone", "Email", "Details"]))).toEqual({ Name: "name", Phone: "phone", Email: "email", Details: "notes" });
  });
});

describe("import invalid-rows CSV", () => {
  it("quotes and defuses spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-500")).toBe("-500");
    expect(csvCell(null)).toBe("");
  });
});
