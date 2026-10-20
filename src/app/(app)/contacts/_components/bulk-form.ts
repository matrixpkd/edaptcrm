/**
 * The id of the bulk assign form. A plain module (not the "use client" bar), so the server-rendered row checkboxes get
 * the string itself: a value imported from a client module reaches a server component as a client reference, which
 * holds each checkbox back until that module's chunk has loaded.
 */
export const BULK_FORM_ID = "bulk-reassign";
