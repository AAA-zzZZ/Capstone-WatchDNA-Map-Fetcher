/**
 * Backfill: normalize all phone numbers in the Location table to E.164.
 * Uses stored country when set; when country is empty, infers a hint from address text
 * so local numbers (e.g. Korean 02-xxx) can still parse.
 *
 *   npm run normalize-phones
 */

import prisma from '../lib/prisma';
import { normalizePhone } from '../utils/normalize-phone';

/**
 * Best-effort country display name for libphonenumber regional hint when DB country is blank.
 * First matching rule wins (order matters — avoid overly broad patterns).
 */
function inferCountryFromAddress(
  addressLine1: string,
  addressLine2: string | null,
  city: string,
  stateProvinceRegion: string | null
): string | undefined {
  const hay = [addressLine1, addressLine2, city, stateProvinceRegion]
    .filter(Boolean)
    .join(' ');

  if (!hay.trim()) return undefined;

  const rules: { test: (s: string) => boolean; country: string }[] = [
    { test: (s) => /경기도|서울특별시|서울 |부산광역시|부산 |대구|인천|광주|대전|울산|세종|강원|충청|전라|경상|제주|대한민국|\bsouth korea\b/i.test(s), country: 'South Korea' },
    { test: (s) => /日本|都道府県|東京|大阪府|大阪市|京都|北海道|沖縄|神奈川|愛知県|兵庫|福岡|広島|名古屋|横浜|埼玉|千葉|静岡|茨城|新潟|長崎|岡山|熊本|鹿児島|札幌|仙台|新宿|渋谷|銀座|表参道/i.test(s), country: 'Japan' },
    { test: (s) => /香港|\bhong kong\b/i.test(s), country: 'Hong Kong' },
    { test: (s) => /澳門|澳门|\bmacau\b/i.test(s), country: 'Macau' },
    { test: (s) => /中国|北京|上海|广州|深圳|浙江|江苏|四川|天津|重庆|山东|福建|湖北|湖南|河南|河北|陕西|辽宁|吉林|黑龙江|云南|贵州|安徽|江西|山西|海南|内蒙古|新疆|西藏|宁夏|青海|甘肃|广西|广东|江苏|苏州|杭州|南京|武汉|成都|西安|郑州|青岛/i.test(s), country: 'China' },
    { test: (s) => /台灣|臺灣|台湾|\btaiwan\b|台北市|新北市|桃園|高雄|台中|台南/i.test(s), country: 'Taiwan' },
    { test: (s) => /新加坡|\bsingapore\b/i.test(s), country: 'Singapore' },
    { test: (s) => /马来西亚|馬來西亞|\bmalaysia\b|kuala lumpur|selangor|johor|penang/i.test(s), country: 'Malaysia' },
    { test: (s) => /泰国|泰國|\bthailand\b|bangkok|กรุงเทพ/i.test(s), country: 'Thailand' },
    { test: (s) => /越南|\bvietnam\b|hanoi|ho chi minh|hồ chí minh/i.test(s), country: 'Vietnam' },
    { test: (s) => /印度尼西亚|印尼|\bindonesia\b|jakarta|bali/i.test(s), country: 'Indonesia' },
    { test: (s) => /菲律宾|\bphilippines\b|manila|quezon|cebu/i.test(s), country: 'Philippines' },
    { test: (s) => /印度|\bindia\b|mumbai|delhi|bangalore|hyderabad/i.test(s), country: 'India' },
    { test: (s) => /澳大利亚|\baustralia\b|sydney|melbourne|brisbane|perth|adelaide/i.test(s), country: 'Australia' },
    { test: (s) => /新西兰|\bnew zealand\b|auckland|wellington/i.test(s), country: 'New Zealand' },
    { test: (s) => /阿联酋|杜拜|迪拜|\buae\b|\bdubai\b|\babu dhabi\b/i.test(s), country: 'United Arab Emirates' },
    { test: (s) => /沙特阿拉伯|\bsaudi arabia\b|riyadh|jeddah/i.test(s), country: 'Saudi Arabia' },
    { test: (s) => /卡塔尔|\bqatar\b|doha/i.test(s), country: 'Qatar' },
    { test: (s) => /科威特|\bkuwait\b/i.test(s), country: 'Kuwait' },
    { test: (s) => /巴林|\bbahrain\b/i.test(s), country: 'Bahrain' },
    { test: (s) => /阿曼|\boman\b|muscat/i.test(s), country: 'Oman' },
    { test: (s) => /以色列|\bisrael\b|tel aviv|jerusalem/i.test(s), country: 'Israel' },
    { test: (s) => /土耳其|\bturkey\b|istanbul|ankara|i̇stanbul/i.test(s), country: 'Turkey' },
    { test: (s) => /俄罗斯|\brussia\b|moscow|saint petersburg|москва/i.test(s), country: 'Russia' },
    { test: (s) => /乌克兰|\bukraine\b|kyiv|kiev/i.test(s), country: 'Ukraine' },
    { test: (s) => /波兰|\bpoland\b|warsaw|krakow/i.test(s), country: 'Poland' },
    { test: (s) => /捷克|\bczech\b|prague|praha/i.test(s), country: 'Czech Republic' },
    { test: (s) => /斯洛伐克|\bslovakia\b|bratislava/i.test(s), country: 'Slovakia' },
    { test: (s) => /匈牙利|\bhungary\b|budapest/i.test(s), country: 'Hungary' },
    { test: (s) => /罗马尼亚|\bromania\b|bucharest/i.test(s), country: 'Romania' },
    { test: (s) => /保加利亚|\bbulgaria\b|sofia/i.test(s), country: 'Bulgaria' },
    { test: (s) => /希腊|\bgreece\b|athens|thessaloniki/i.test(s), country: 'Greece' },
    { test: (s) => /葡萄牙|\bportugal\b|lisbon|porto/i.test(s), country: 'Portugal' },
    { test: (s) => /西班牙|\bspain\b|madrid|barcelona|valencia|sevilla/i.test(s), country: 'Spain' },
    { test: (s) => /意大利|\bitaly\b|roma|milano|napoli|torino|firenze|venezia/i.test(s), country: 'Italy' },
    { test: (s) => /法国|\bfrance\b|paris|lyon|marseille|toulouse|nice|nantes/i.test(s), country: 'France' },
    { test: (s) => /德国|\bgermany\b|deutschland|berlin|münchen|munich|hamburg|frankfurt|köln|cologne|stuttgart|düsseldorf/i.test(s), country: 'Germany' },
    { test: (s) => /荷兰|\bnetherlands\b|amsterdam|rotterdam|den haag|utrecht/i.test(s), country: 'Netherlands' },
    { test: (s) => /比利时|\bbelgium\b|brussels|antwerp|gent/i.test(s), country: 'Belgium' },
    { test: (s) => /卢森堡|\bluxembourg\b/i.test(s), country: 'Luxembourg' },
    { test: (s) => /瑞士|\bswitzerland\b|zürich|zurich|geneva|genève|basel|bern/i.test(s), country: 'Switzerland' },
    { test: (s) => /奥地利|\baustria\b|vienna|wien|salzburg/i.test(s), country: 'Austria' },
    { test: (s) => /瑞典|\bsweden\b|stockholm|göteborg|gothenburg|malmö/i.test(s), country: 'Sweden' },
    { test: (s) => /挪威|\bnorway\b|oslo|bergen/i.test(s), country: 'Norway' },
    { test: (s) => /丹麦|\bdenmark\b|copenhagen|aarhus/i.test(s), country: 'Denmark' },
    { test: (s) => /芬兰|\bfinland\b|helsinki|tampere/i.test(s), country: 'Finland' },
    { test: (s) => /爱尔兰|\bireland\b|dublin|cork/i.test(s), country: 'Ireland' },
    { test: (s) => /英国|英格兰|苏格兰|威尔士|北爱尔兰|\bunited kingdom\b|\bengland\b|\bscotland\b|\bwales\b|london|manchester|birmingham|glasgow|edinburgh|liverpool|leeds|bristol|sheffield|cardiff|belfast|holmfirth|yorkshire/i.test(s), country: 'United Kingdom' },
    { test: (s) => /加拿大|\bcanada\b|toronto|montreal|vancouver|calgary|ottawa|edmonton/i.test(s), country: 'Canada' },
    { test: (s) => /墨西哥|\bmexico\b|méxico|ciudad de méxico|guadalajara|monterrey|puebla|tijuana/i.test(s), country: 'Mexico' },
    { test: (s) => /巴西|\bbrazil\b|são paulo|rio de janeiro|brasília/i.test(s), country: 'Brazil' },
    { test: (s) => /阿根廷|\bargentina\b|buenos aires/i.test(s), country: 'Argentina' },
    { test: (s) => /智利|\bchile\b|santiago/i.test(s), country: 'Chile' },
    { test: (s) => /哥伦比亚|\bcolombia\b|bogotá|medellín/i.test(s), country: 'Colombia' },
    { test: (s) => /秘鲁|\bperu\b|lima/i.test(s), country: 'Peru' },
    { test: (s) => /南非|\bsouth africa\b|johannesburg|cape town|durban/i.test(s), country: 'South Africa' },
    { test: (s) => /埃及|\begypt\b|cairo/i.test(s), country: 'Egypt' },
    { test: (s) => /尼日利亚|\bnigeria\b|lagos/i.test(s), country: 'Nigeria' },
    { test: (s) => /日本橋|伊勢丹|大丸|阪急|高島屋|松坂屋|三越|丸井|ヨドバシ|ビックカメラ/i.test(s), country: 'Japan' },
  ];

  for (const { test, country } of rules) {
    if (test(hay)) return country;
  }
  return undefined;
}

async function run() {
  const locations = await prisma.location.findMany({
    select: {
      id: true,
      handle: true,
      phone: true,
      country: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      stateProvinceRegion: true,
    },
  });

  console.log(`Found ${locations.length} location(s) to check.`);

  let updated = 0;
  let unchanged = 0;
  let cleared = 0;

  for (const loc of locations) {
    const storedCountry = loc.country?.trim() ?? '';
    const inferred = storedCountry
      ? undefined
      : inferCountryFromAddress(loc.addressLine1, loc.addressLine2, loc.city, loc.stateProvinceRegion);
    const effectiveCountry = storedCountry || inferred;

    const normalized = normalizePhone(loc.phone, effectiveCountry || undefined);
    if (normalized === loc.phone) {
      unchanged++;
      continue;
    }

    await prisma.location.update({
      where: { id: loc.id },
      data: { phone: normalized },
    });

    if (normalized === null && loc.phone !== null) {
      cleared++;
      console.log(`  CLEARED  [${loc.handle}] "${loc.phone}" → null`);
    } else {
      updated++;
      const hint = inferred && !storedCountry ? ` (inferred ${inferred})` : '';
      console.log(`  UPDATED  [${loc.handle}] "${loc.phone}" → "${normalized}"${hint}`);
    }
  }

  console.log(`\nDone. Updated: ${updated} | Cleared: ${cleared} | Unchanged: ${unchanged}`);
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
