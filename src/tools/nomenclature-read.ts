import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { ok, guard, databaseField } from "./_shared.js";
import { requireEntity } from "../odata/publication.js";
import { CATALOGS } from "../config/mapping.js";
import { fetchAll } from "../odata/pagination.js";
import { and, contains, cmp, or, odataGuid, buildQuery } from "../odata/query.js";
import { catalogFields } from "../odata/catalog-fields.js";

export function registerNomenclatureRead(server: McpServer, ctx: ServerContext): void {
  server.registerTool("read.nomenclature.list_nomenclature", {
    title: "Номенклатура базы 1С",
    description: "Читает справочник номенклатуры: название, код, единицу и признак услуги, если они опубликованы. query — поиск по названию; пустой query — список. Для следующих страниц передавайте nextOffset. Поля подбираются по метаданным выбранной базы, включая Казахстан.",
    inputSchema: {
      database: databaseField, query: z.string().max(200).default(""),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).max(1000000).default(0),
    },
    outputSchema: z.object({database:z.string(),rows:z.array(z.object({ref:z.string(),name:z.string(),code:z.string().optional(),unit:z.string().optional(),unitRef:z.string().optional(),isService:z.boolean().optional()}).passthrough()),count:z.number(),truncated:z.boolean(),nextOffset:z.number().optional(),note:z.string().optional()}).passthrough(),
  }, ({database,query,limit,offset}) => guard("read.nomenclature.list_nomenclature", async () => {
    const conn = ctx.db(database);
    const set = await requireEntity(conn, CATALOGS.nomenclature, "Справочник «Номенклатура»");
    const fields = await catalogFields(conn,set);
    const meta = await conn.getMetadata();
    const properties = meta.entities.get(set)!.properties;
    const choose = (names: string[], type?: string) => names.find(n => properties.some(p => p.name === n && (!type || p.type === type))) ?? "";
    const unitKey = choose(["ЕдиницаИзмерения_Key","БазоваяЕдиницаИзмерения_Key","ЕдиницаХраненияОстатков_Key"]);
    const unitText = choose(["ЕдиницаИзмерения","БазоваяЕдиницаИзмерения"],"Edm.String");
    const service = choose(["Услуга","ЭтоУслуга"],"Edm.Boolean");
    const filter = and(query.trim() ? contains(fields.name,query.trim()) : undefined,fields.isFolder ? cmp(fields.isFolder,"eq","false") : undefined);
    const {rows,truncated} = await fetchAll(conn.client,set,{select:[fields.ref,fields.name,fields.code,unitKey,unitText,service].filter(Boolean),filter,orderby:fields.name + "," + fields.ref,skip:offset},conn.behavior.pageSize,Math.min(limit,conn.behavior.maxRows));
    const unitNames = new Map<string,string>();
    let unitWarning = false;
    const refs = [...new Set(rows.map(r => String(r[unitKey] ?? "")).filter(r => /^[a-f0-9-]{36}$/i.test(r) && r !== "00000000-0000-0000-0000-000000000000"))];
    const unitSet = ["Catalog_ЕдиницыИзмерения","Catalog_КлассификаторЕдиницИзмерения","Catalog_УпаковкиЕдиницыИзмерения"].find(s => meta.entities.has(s));
    if(refs.length && unitSet) {
      try {
        const uf = await catalogFields(conn,unitSet);
        const page = await conn.client.getCollection(unitSet + buildQuery({select:[uf.ref,uf.name],filter:or(...refs.map(r => cmp(uf.ref,"eq",odataGuid(r)))),top:refs.length}));
        for(const u of page.value ?? []) unitNames.set(String(u[uf.ref]),String(u[uf.name]));
      } catch { unitWarning = true; }
    }
    const result = rows.map(r => {
      const unitRef = r[unitKey] ? String(r[unitKey]) : undefined;
      return {ref:String(r[fields.ref]),name:String(r[fields.name]),
        ...(r[fields.code] ? {code:String(r[fields.code])} : {}),
        ...(unitRef ? {unitRef} : {}),
        ...(r[unitText] ? {unit:String(r[unitText])} : unitRef && unitNames.has(unitRef) ? {unit:unitNames.get(unitRef)} : {}),
        ...(typeof r[service] === "boolean" ? {isService:r[service] as boolean} : {}),
      };
    });
    return ok({database:conn.cfg.name,rows:result,count:result.length,truncated,
      ...(truncated ? {nextOffset:offset+rows.length} : {}),
      ...(unitWarning ? {note:"Наименования единиц получить не удалось; доступны ссылки unitRef."} : {}),
    });
  }));
}
