import { attributeVomit, describeDiagnosis, HIGH_NAUSEA, MIN_NAUSEA } from "./build/vomit.mjs";
let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const src=(id,name,nausea,x,y)=>({rideId:id,name,nausea,x,y});

ok(MIN_NAUSEA===500 && HIGH_NAUSEA===750, "thresholds");

// empty inputs
ok(attributeVomit([],[],10).length===0, "empty clusters");
ok(attributeVomit([{x:1,y:1,vomit:5}],[],10)[0].source===null, "no sources -> null source");

// zero-vomit clusters excluded
ok(attributeVomit([{x:1,y:1,vomit:0}],[src(1,"A",800,1,1)],10).length===0, "zero-vomit excluded");

// all sources below MIN_NAUSEA ignored
const r1=attributeVomit([{x:5,y:5,vomit:9}],[src(1,"Gentle",400,5,5)],10);
ok(r1[0].source===null && r1[0].distance===-1, "sub-threshold source ignored");

// nearest wins
const r2=attributeVomit([{x:10,y:10,vomit:9}],[src(1,"Far",900,20,10),src(2,"Near",600,12,10)],20);
ok(r2[0].source.name==="Near" && r2[0].distance===2, "nearest wins, got "+JSON.stringify(r2[0].source));

// tie on distance -> higher nausea wins
const r3=attributeVomit([{x:0,y:0,vomit:9}],[src(1,"LowN",600,3,0),src(2,"HighN",900,0,3)],20);
ok(r3[0].source.name==="HighN", "tie-break prefers higher nausea, got "+r3[0].source.name);

// out of range -> null
const r4=attributeVomit([{x:0,y:0,vomit:9}],[src(1,"Far",900,50,50)],10);
ok(r4[0].source===null && r4[0].distance===-1, "out of range -> null");

// sorted by vomit desc
const r5=attributeVomit([{x:1,y:1,vomit:3},{x:2,y:2,vomit:30},{x:3,y:3,vomit:12}],[],50);
ok(r5.map(d=>d.vomit).join()==="30,12,3", "sorted desc, got "+r5.map(d=>d.vomit).join());

// distance is Manhattan
const r6=attributeVomit([{x:0,y:0,vomit:1}],[src(1,"D",800,3,4)],20);
ok(r6[0].distance===7, "manhattan distance, got "+r6[0].distance);

// describeDiagnosis
const d=r2[0];
const noBench=describeDiagnosis(d,0), withBench=describeDiagnosis(d,2);
ok(noBench.includes("bench") && !noBench.endsWith("\n"), "no-bench text mentions benches, no trailing newline");
ok(withBench!==noBench && /nausea/i.test(withBench), "bench-present text differs");
ok(/6\.00/.test(noBench), "fixed-point rendered as decimal, got: "+noBench);
const none=describeDiagnosis(r4[0],0);
ok(!/likely from/.test(none), "null source does not invent a cause");
console.log("\nSAMPLES:\n "+noBench+"\n "+withBench+"\n "+none);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
