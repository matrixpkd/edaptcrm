"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, fail, num, ok, str, type ActionResult } from "@/lib/action";
import { createProduct, deleteProduct, saveLadder, updateProduct, type ProductInput } from "@/lib/admin/products";
import { adminForAction, failFrom, jsonField, NOT_ADMIN, withWarnings } from "../_lib/guard";

const PAGE = "/settings/products";

function input(fd: FormData): ProductInput {
  return {
    name: str(fd, "name"),
    family: str(fd, "family"),
    listPrice: num(fd, "listPrice"),
    currency: str(fd, "currency"),
    active: bool(fd, "active"),
    externalIds: (str(fd, "externalIds") ?? "").split(/\r?\n/),
    description: str(fd, "description"),
  };
}

function touch() {
  revalidatePath(PAGE);
  revalidatePath("/payments");
}

export async function createProductAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  try {
    await createProduct(input(fd), admin);
  } catch (e) {
    return failFrom(e, "create product");
  }
  touch();
  redirect(`${PAGE}?saved=1`);
}

export async function updateProductAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const id = str(fd, "id") ?? "";
  try {
    await updateProduct(id, input(fd), admin);
  } catch (e) {
    return failFrom(e, "update product");
  }
  touch();
  revalidatePath(`${PAGE}/${id}`);
  return ok(undefined, "Product saved. New purchases use it; past purchases keep their own name and price.");
}

export async function deleteProductAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  try {
    await deleteProduct(str(fd, "id") ?? "", admin);
  } catch (e) {
    return failFrom(e, "delete product");
  }
  touch();
  redirect(`${PAGE}?deleted=1`);
}

export async function saveLadderAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const j = jsonField(fd);
  if (!j.ok) return fail("Nothing to save. Reload the page and try again.");
  const v = j.value as { rungs?: unknown; families?: unknown };
  try {
    const { productsMoved, warnings } = await saveLadder({ rungs: v.rungs, families: v.families }, admin);
    touch();
    return ok(
      undefined,
      withWarnings(
        `Ladder saved${productsMoved ? `; ${productsMoved} product${productsMoved === 1 ? "" : "s"} moved to their family's new rung` : ""}. Recalculate scores to update every contact's rung and offer now.`,
        warnings,
      ),
    );
  } catch (e) {
    return failFrom(e, "save ladder");
  }
}
