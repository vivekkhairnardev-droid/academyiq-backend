import { neonQuery } from "./neon.js";

/**
 * Lightweight chainable query builder backed by Neon SQL.
 * Provides a familiar .from().select().eq().single() API backed by Neon SQL.
 */

interface QueryResult<T = any> {
  data: T | null;
  error: { message: string } | null;
}

type FilterOp = "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike";

interface WhereClause {
  column: string;
  op: FilterOp;
  value: any;
}

interface OrderClause {
  column: string;
  ascending: boolean;
}

class QueryBuilder {
  private tableName: string;
  private operation: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private selectColumns: string = "*";
  private whereClauses: WhereClause[] = [];
  private orderClauses: OrderClause[] = [];
  private limitCount: number | null = null;
  private isSingle: boolean = false;
  private insertData: any = null;
  private updateData: any = null;
  private upsertConflict: string = "";
  private returnSelect: boolean = false;

  constructor(table: string) {
    this.tableName = table;
  }

  select(columns: string = "*"): this {
    if (this.operation === "select") {
      this.selectColumns = columns;
    } else {
      this.selectColumns = columns;
    }
    return this;
  }

  insert(data: any): this {
    this.operation = "insert";
    this.insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  upsert(data: any, options?: { onConflict?: string }): this {
    this.operation = "upsert";
    this.insertData = Array.isArray(data) ? data : [data];
    this.upsertConflict = options?.onConflict || "";
    return this;
  }

  update(data: any): this {
    this.operation = "update";
    this.updateData = data;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: any): this {
    this.whereClauses.push({ column, op: "eq", value });
    return this;
  }

  neq(column: string, value: any): this {
    this.whereClauses.push({ column, op: "neq", value });
    return this;
  }

  in(column: string, values: any[]): this {
    this.whereClauses.push({ column, op: "in", value: values });
    return this;
  }

  gt(column: string, value: any): this {
    this.whereClauses.push({ column, op: "gt", value });
    return this;
  }

  gte(column: string, value: any): this {
    this.whereClauses.push({ column, op: "gte", value });
    return this;
  }

  lt(column: string, value: any): this {
    this.whereClauses.push({ column, op: "lt", value });
    return this;
  }

  lte(column: string, value: any): this {
    this.whereClauses.push({ column, op: "lte", value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderClauses.push({
      column,
      ascending: options?.ascending ?? true,
    });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.isSingle = true;
    this.limitCount = 1;
    return this;
  }

  // Allow chaining .select() after .insert()/.update() to return the row
  // This is detected by checking if operation is insert/update and select is called after
  private _buildWhereSQL(params: any[], startIdx: number): string {
    if (this.whereClauses.length === 0) return "";

    const parts: string[] = [];
    let idx = startIdx;

    for (const w of this.whereClauses) {
      if (w.op === "in") {
        const placeholders = (w.value as any[]).map(() => `$${++idx}`).join(", ");
        parts.push(`"${w.column}" IN (${placeholders})`);
        params.push(...w.value);
      } else {
        const opMap: Record<string, string> = {
          eq: "=",
          neq: "!=",
          gt: ">",
          gte: ">=",
          lt: "<",
          lte: "<=",
          like: "LIKE",
          ilike: "ILIKE",
        };
        parts.push(`"${w.column}" ${opMap[w.op]} $${++idx}`);
        params.push(w.value);
      }
    }

    return ` WHERE ${parts.join(" AND ")}`;
  }

  private _buildOrderSQL(): string {
    if (this.orderClauses.length === 0) return "";
    const parts = this.orderClauses.map(
      (o) => `"${o.column}" ${o.ascending ? "ASC" : "DESC"}`
    );
    return ` ORDER BY ${parts.join(", ")}`;
  }

  async then(
    resolve: (value: QueryResult) => void,
    reject?: (reason: any) => void
  ): Promise<void> {
    try {
      const result = await this.execute();
      resolve(result);
    } catch (err: any) {
      if (reject) reject(err);
      else resolve({ data: null, error: { message: err.message } });
    }
  }

  async execute(): Promise<QueryResult> {
    try {
      const params: any[] = [];
      let sql = "";

      switch (this.operation) {
        case "select": {
          sql = `SELECT ${this.selectColumns} FROM public."${this.tableName}"`;
          sql += this._buildWhereSQL(params, 0);
          sql += this._buildOrderSQL();
          if (this.limitCount !== null) {
            sql += ` LIMIT ${this.limitCount}`;
          }
          break;
        }

        case "insert": {
          const rows = this.insertData as any[];
          if (!rows || rows.length === 0) {
            return { data: null, error: { message: "No data to insert" } };
          }

          const columns = Object.keys(rows[0]);
          const colNames = columns.map((c) => `"${c}"`).join(", ");
          const valueSets: string[] = [];

          let idx = 0;
          for (const row of rows) {
            const placeholders = columns.map((c) => {
              idx++;
              const val = row[c];
              params.push(
                typeof val === "object" && val !== null
                  ? JSON.stringify(val)
                  : val
              );
              return `$${idx}`;
            });
            valueSets.push(`(${placeholders.join(", ")})`);
          }

          sql = `INSERT INTO public."${this.tableName}" (${colNames}) VALUES ${valueSets.join(", ")} RETURNING ${this.selectColumns}`;
          break;
        }

        case "upsert": {
          const rows = this.insertData as any[];
          if (!rows || rows.length === 0) {
            return { data: null, error: { message: "No data to upsert" } };
          }

          const columns = Object.keys(rows[0]);
          const colNames = columns.map((c) => `"${c}"`).join(", ");
          const valueSets: string[] = [];

          let idx = 0;
          for (const row of rows) {
            const placeholders = columns.map((c) => {
              idx++;
              const val = row[c];
              params.push(
                typeof val === "object" && val !== null
                  ? JSON.stringify(val)
                  : val
              );
              return `$${idx}`;
            });
            valueSets.push(`(${placeholders.join(", ")})`);
          }

          const updateCols = columns
            .filter((c) => !this.upsertConflict.split(",").map(s => s.trim()).includes(c))
            .map((c) => `"${c}" = EXCLUDED."${c}"`)
            .join(", ");

          sql = `INSERT INTO public."${this.tableName}" (${colNames}) VALUES ${valueSets.join(", ")}`;
          if (this.upsertConflict) {
            const conflictCols = this.upsertConflict.split(",").map(s => `"${s.trim()}"`).join(", ");
            sql += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols}`;
          }
          sql += ` RETURNING ${this.selectColumns}`;
          break;
        }

        case "update": {
          if (!this.updateData) {
            return { data: null, error: { message: "No data to update" } };
          }

          const setClauses: string[] = [];
          let idx = 0;
          for (const [key, val] of Object.entries(this.updateData)) {
            idx++;
            setClauses.push(`"${key}" = $${idx}`);
            params.push(
              typeof val === "object" && val !== null
                ? JSON.stringify(val)
                : val
            );
          }

          sql = `UPDATE public."${this.tableName}" SET ${setClauses.join(", ")}`;
          sql += this._buildWhereSQL(params, idx);
          sql += ` RETURNING ${this.selectColumns}`;
          break;
        }

        case "delete": {
          sql = `DELETE FROM public."${this.tableName}"`;
          sql += this._buildWhereSQL(params, 0);
          sql += ` RETURNING ${this.selectColumns}`;
          break;
        }
      }

      const rows = await neonQuery(sql, params);

      if (this.isSingle) {
        if (rows.length === 0) {
          return {
            data: null,
            error: { message: `Row not found in ${this.tableName}` },
          };
        }
        return { data: rows[0], error: null };
      }

      return { data: rows, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message || "Query failed" } };
    }
  }
}

/**
 * Create a chainable query builder for a given table.
 * Usage: db.from("exams").select("*").eq("id", examId).single()
 */
export const db = {
  from(table: string): QueryBuilder {
    return new QueryBuilder(table);
  },
};

/**
 * Raw SQL query helper — re-exported for convenience.
 */
export { neonQuery } from "./neon.js";
