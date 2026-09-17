// Registry 출력의 기준값을 만든다.
//
// 이 파일이 만드는 app/fixtures/registry.sample.json 은 샘플이 아니라 테스트 벡터다.
// 다른 구현으로 Registry를 다시 만들었을 때 같은 입력에서 같은 Root가 나오는지 대조하면,
// 값 표현이나 Poseidon 사용법이 어긋났는지 바로 드러난다.
//
// 실행: node script/make-registry-fixture.js
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../app/lib/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const accounts = JSON.parse(await readFile(join(ROOT, "data", "accounts.json"), "utf8"));
const registry = await buildRegistry({ accounts });

const fixture = {
  note: "Registry 구현이 같은 Root를 내는지 대조하는 기준값이다. 손으로 고치지 말고 이 스크립트로 다시 만든다.",
  rootEpoch: 1,
  ...registry,
};
delete fixture.inTreeCount;

const out = join(ROOT, "app", "fixtures", "registry.sample.json");
await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");

console.log(`eligibilityRoot ${registry.eligibilityRoot}`);
console.log(`트리 안 ${registry.inTreeCount}개, 제외 ${registry.records.length - registry.inTreeCount}개`);
console.log(`기록: ${out}`);
