"use server";
import { revalidatePath } from "next/cache";
import { fail, num, ok, str, type ActionResult } from "@/lib/action";
import { editCurrency, type CurrencyEdit } from "@/lib/admin/currency";
import { adminForAction, failFrom, NOT_ADMIN } from "../_lib/guard";

async function run(edit: CurrencyEdit, message: string): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  try {
    await editCurrency(edit, admin);
  } catch (e) {
    return failFrom(e, `currency ${edit.op}`);
  }
  revalidatePath("/settings/currency");
  revalidatePath("/payments");
  return ok(undefined, message);
}

export async function addCurrencyAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const currency = (str(fd, "currency") ?? "").toUpperCase();
  return run({ op: "add", currency, month: str(fd, "month") ?? "", rate: num(fd, "rate") }, `${currency} added. It now appears on payment forms.`);
}

export async function toggleCurrencyAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const currency = str(fd, "currency") ?? "";
  const on = str(fd, "on") === "1";
  return run({ op: "enable", currency, on }, on ? `${currency} switched on.` : `${currency} switched off. Saved payments in it are unchanged.`);
}

export async function setRateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const currency = str(fd, "currency") ?? "";
  const month = str(fd, "month") ?? "";
  return run({ op: "setRate", currency, month, rate: num(fd, "rate") }, `${currency} rate for ${month} saved. Payments already saved keep their own rate.`);
}

export async function deleteRateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const currency = str(fd, "currency") ?? "";
  const month = str(fd, "month") ?? "";
  return run({ op: "deleteRate", currency, month }, `${currency} rate for ${month} deleted.`);
}
