import { categoriseThought, createThoughtAccumulator, describeThoughts, PROBLEM_CATEGORIES } from "./build/thoughts.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const ALL="cant_afford_ride,spent_money,sick,very_sick,more_thrilling,intense,havent_finished,sickening,bad_value,go_home,good_value,already_got,cant_afford_item,not_hungry,not_thirsty,drowning,lost,was_great,queuing_ages,tired,hungry,thirsty,toilet,cant_find,not_paying,not_while_raining,bad_litter,cant_find_exit,get_off,get_out,not_safe,path_disgusting,crowded,vandalism,scenery,very_clean,fountains,music,balloon,toy,map,photo,umbrella,drink,burger,chips,ice_cream,candyfloss,pizza,popcorn,hot_dog,tentacle,hat,toffee_apple,tshirt,doughnut,coffee,chicken,lemonade,wow,wow2,watched,balloon_much,toy_much,map_much,photo_much,umbrella_much,drink_much,burger_much,chips_much,ice_cream_much,candyfloss_much,pizza_much,popcorn_much,hot_dog_much,tentacle_much,hat_much,toffee_apple_much,tshirt_much,doughnut_much,coffee_much,chicken_much,lemonade_much,photo2,photo3,photo4,pretzel,hot_chocolate,iced_tea,funnel_cake,sunglasses,beef_noodles,fried_rice_noodles,wonton_soup,meatball_soup,fruit_juice,soybean_milk,sujongkwa,sub_sandwich,cookie,roast_sausage,photo2_much,photo3_much,photo4_much,pretzel_much,hot_chocolate_much,iced_tea_much,funnel_cake_much,sunglasses_much,beef_noodles_much,fried_rice_noodles_much,wonton_soup_much,meatball_soup_much,fruit_juice_much,soybean_milk_much,sujongkwa_much,sub_sandwich_much,cookie_much,roast_sausage_much,help,running_out,new_ride,nice_ride_deprecated,excited_deprecated,here_we_are".split(",");
ok(ALL.length===125,"125 types, got "+ALL.length);
// every type must categorise without throwing
let bad=[]; for(const t of ALL){ try{ const c=categoriseThought(t); if(typeof c!=="string") bad.push(t);}catch(e){bad.push(t);} }
ok(bad.length===0,"all 125 categorise: "+bad.join(","));
// THE TRAP: every _much is has_too_many, including multi-underscore item names
const muchBad=ALL.filter(t=>t.endsWith("_much")&&categoriseThought(t)!=="has_too_many");
ok(muchBad.length===0,"_much -> has_too_many: "+muchBad.join(","));
ok(categoriseThought("hot_dog_much")==="has_too_many","hot_dog_much (2 underscores)");
ok(categoriseThought("sub_sandwich_much")==="has_too_many","sub_sandwich_much");
ok(categoriseThought("fried_rice_noodles_much")==="has_too_many","fried_rice_noodles_much (3 underscores)");
// and the base names are NOT has_too_many
ok(categoriseThought("hot_dog")==="wants_item","hot_dog is wants_item, got "+categoriseThought("hot_dog"));
ok(categoriseThought("fried_rice_noodles")==="wants_item","fried_rice_noodles is wants_item");
// spot-check key categories
ok(categoriseThought("bad_litter")==="cleanliness","bad_litter");
ok(categoriseThought("path_disgusting")==="cleanliness","path_disgusting");
ok(categoriseThought("vandalism")==="cleanliness","vandalism");
ok(categoriseThought("queuing_ages")==="queue","queuing_ages");
ok(categoriseThought("drowning")==="safety","drowning");
ok(categoriseThought("go_home")==="leaving","go_home");
ok(categoriseThought("was_great")==="positive","was_great");
ok(categoriseThought("toilet")==="needs","toilet");
ok(categoriseThought("very_sick")==="sickness","very_sick");
ok(categoriseThought("lost")==="navigation","lost");
ok(categoriseThought("nice_ride_deprecated")==="other","deprecated -> other");
ok(categoriseThought("totally_made_up_xyz")==="other","unknown -> other, no throw");
ok(!PROBLEM_CATEGORIES.includes("positive") && PROBLEM_CATEGORIES.includes("cleanliness"),"PROBLEM_CATEGORIES sane");
// accumulator
const a=createThoughtAccumulator(50);
ok(a.top(3).length===0 && a.total()===0,"empty");
ok(a.top(0).length===0,"n<=0");
a.add("bad_litter",10); a.add("bad_litter",10); a.add("path_disgusting",10); a.add("was_great",10);
ok(a.total()===4,"total, got "+a.total());
const t=a.top(5); ok(t[0].category==="cleanliness"&&t[0].count===3,"cleanliness tallied 3, got "+JSON.stringify(t[0]));
ok(t[0].topType==="bad_litter"&&t[0].topTypeCount===2,"topType tracked");
const pr=a.problems(5); ok(pr.every(x=>x.category!=="positive"),"problems excludes positive");
// freshness filter: LOWER is fresher, above max is ignored
const f=createThoughtAccumulator(20);
f.add("bad_litter",5); f.add("bad_litter",999);
ok(f.total()===1,"stale thought filtered, got "+f.total());
// div by zero
ok(typeof describeThoughts(t[0],0)==="string","sampledGuests=0 no crash");
a.reset(); ok(a.total()===0,"reset");
console.log("\nSAMPLE: "+describeThoughts(t[0],40));
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
