import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface EventInput {
  event: string;
  properties?: Record<string, any>;
  sessionId?: string;
  deviceType?: string;
}

interface DateRange {
  from: Date;
  to: Date;
}

function getDateRange(days: number): DateRange {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from, to };
}

class AnalyticsService {
  /**
   * Record a single analytics event
   */
  async recordEvent(input: EventInput) {
    return prisma.analyticsEvent.create({
      data: {
        event: input.event,
        properties: input.properties ? JSON.stringify(input.properties) : null,
        sessionId: input.sessionId || null,
        deviceType: input.deviceType || null,
      },
    });
  }

  /**
   * Record a batch of analytics events
   */
  async recordBatch(events: EventInput[]) {
    return prisma.analyticsEvent.createMany({
      data: events.map((e) => ({
        event: e.event,
        properties: e.properties ? JSON.stringify(e.properties) : null,
        sessionId: e.sessionId || null,
        deviceType: e.deviceType || null,
      })),
    });
  }

  /**
   * Summary stats: total events, unique sessions, events today
   */
  async getSummary(days: number = 30) {
    const { from, to } = getDateRange(days);

    const [totalEvents, uniqueSessions, eventsToday] = await Promise.all([
      prisma.analyticsEvent.count({
        where: { createdAt: { gte: from, lte: to } },
      }),
      prisma.analyticsEvent.groupBy({
        by: ['sessionId'],
        where: {
          createdAt: { gte: from, lte: to },
          sessionId: { not: null },
        },
      }),
      prisma.analyticsEvent.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    return {
      totalEvents,
      uniqueSessions: uniqueSessions.length,
      eventsToday,
      periodDays: days,
    };
  }

  /**
   * Top retailers by tap count, with breakdown of phone/directions/website clicks
   */
  async getRetailerStats(days: number = 30) {
    const { from } = getDateRange(days);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        event: {
          in: [
            'store_tapped',
            'store_phone_tapped',
            'store_directions_tapped',
            'store_website_tapped',
          ],
        },
        createdAt: { gte: from },
      },
      select: { event: true, properties: true },
    });

    // Aggregate by store
    const storeMap = new Map<
      string,
      {
        storeId: string;
        storeName: string;
        taps: number;
        phoneTaps: number;
        directionTaps: number;
        websiteTaps: number;
      }
    >();

    for (const e of events) {
      const props = e.properties ? JSON.parse(e.properties) : {};
      const storeId = props.storeId || 'unknown';
      const storeName = props.storeName || 'Unknown';

      if (!storeMap.has(storeId)) {
        storeMap.set(storeId, {
          storeId,
          storeName,
          taps: 0,
          phoneTaps: 0,
          directionTaps: 0,
          websiteTaps: 0,
        });
      }

      const entry = storeMap.get(storeId)!;
      if (e.event === 'store_tapped') entry.taps++;
      if (e.event === 'store_phone_tapped') entry.phoneTaps++;
      if (e.event === 'store_directions_tapped') entry.directionTaps++;
      if (e.event === 'store_website_tapped') entry.websiteTaps++;
    }

    return Array.from(storeMap.values())
      .sort((a, b) => b.taps - a.taps)
      .slice(0, 50);
  }

  /**
   * Top searched and viewed brands
   */
  async getBrandStats(days: number = 30) {
    const { from } = getDateRange(days);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        event: { in: ['brand_searched', 'brand_viewed'] },
        createdAt: { gte: from },
      },
      select: { event: true, properties: true },
    });

    const brandMap = new Map<
      string,
      { brand: string; searches: number; views: number }
    >();

    for (const e of events) {
      const props = e.properties ? JSON.parse(e.properties) : {};
      // For brand_searched, the query is the brand; for brand_viewed, it's brandName
      const brand =
        e.event === 'brand_searched'
          ? (props.query || '').toLowerCase()
          : (props.brandName || '').toLowerCase();
      if (!brand) continue;

      if (!brandMap.has(brand)) {
        brandMap.set(brand, { brand, searches: 0, views: 0 });
      }

      const entry = brandMap.get(brand)!;
      if (e.event === 'brand_searched') entry.searches++;
      if (e.event === 'brand_viewed') entry.views++;
    }

    return Array.from(brandMap.values())
      .sort((a, b) => b.searches + b.views - (a.searches + a.views))
      .slice(0, 50);
  }

  /**
   * Action breakdown: phone, directions, website clicks
   */
  async getActionStats(days: number = 30) {
    const { from } = getDateRange(days);

    const [phoneTaps, directionTaps, websiteTaps, emailTaps] =
      await Promise.all([
        prisma.analyticsEvent.count({
          where: { event: 'store_phone_tapped', createdAt: { gte: from } },
        }),
        prisma.analyticsEvent.count({
          where: {
            event: 'store_directions_tapped',
            createdAt: { gte: from },
          },
        }),
        prisma.analyticsEvent.count({
          where: { event: 'store_website_tapped', createdAt: { gte: from } },
        }),
        prisma.analyticsEvent.count({
          where: { event: 'store_email_tapped', createdAt: { gte: from } },
        }),
      ]);

    return { phoneTaps, directionTaps, websiteTaps, emailTaps };
  }

  /**
   * Traffic source breakdown: store locator (map) vs search directory
   */
  async getSourceStats(days: number = 30) {
    const { from } = getDateRange(days);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        event: 'screen_viewed',
        createdAt: { gte: from },
      },
      select: { properties: true },
    });

    let storeLocator = 0;
    let searchDirectory = 0;

    for (const e of events) {
      const props = e.properties ? JSON.parse(e.properties) : {};
      if (props.screen === 'store_locator') storeLocator++;
      if (props.screen === 'search_directory') searchDirectory++;
    }

    return { storeLocator, searchDirectory };
  }

  /**
   * Daily event counts for time series chart
   */
  async getDailyStats(days: number = 30) {
    const { from } = getDateRange(days);

    const events = await prisma.analyticsEvent.findMany({
      where: { createdAt: { gte: from } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by date string
    const dayMap = new Map<string, number>();
    for (const e of events) {
      const day = e.createdAt.toISOString().split('T')[0];
      dayMap.set(day, (dayMap.get(day) || 0) + 1);
    }

    // Fill in missing days with 0
    const result: { date: string; count: number }[] = [];
    const current = new Date(from);
    while (current <= new Date()) {
      const day = current.toISOString().split('T')[0];
      result.push({ date: day, count: dayMap.get(day) || 0 });
      current.setDate(current.getDate() + 1);
    }

    return result;
  }
}

export default new AnalyticsService();
