/** Legacy user.is_deleted is nullable BIT(1); NULL predates explicit zero flags. */
export function isActiveEmployeeFlag(value: unknown): boolean {
 if (value && typeof value === "object" && "type" in value && "data" in value) {
  const bit = value as { type: unknown; data: unknown };
  return bit.type === "Buffer" && Array.isArray(bit.data) && bit.data.length === 1 && bit.data[0] === 0;
 }
 return value === null || value === false || value === 0 || value === "0" || value === "false";
}
