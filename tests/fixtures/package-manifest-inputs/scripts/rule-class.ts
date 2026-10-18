import { loadRuleFile } from "../../../../scripts/rule-class.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
 console.error("usage: fixture rule-class.ts <rule.md>...");
 process.exit(2);
}
for (const file of files) {
 const rule = loadRuleFile(file);
 console.log(`${rule.name}\t${rule.cls}`);
}
