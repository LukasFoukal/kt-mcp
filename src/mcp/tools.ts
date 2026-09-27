/**
 * The tool surface Claude sees.
 *
 * Designed around one flow: "I ate 3 eggs" → search → pick a portion unit →
 * log. Activities follow the same search → log shape, and weight is a single
 * write. Descriptions are prescriptive about *when* to call each tool, because
 * that is what drives correct tool selection.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GRAM_UNIT, KtClient, MEALS, type MealId, todayCzech } from '../kt/client.js';

const MEAL_IDS = Object.keys(MEALS) as [MealId, ...MealId[]];

const mealDescription = `Which meal slot to file the entry under: ${Object.entries(MEALS)
  .map(([id, name]) => `${id} = ${name}`)
  .join(', ')}.`;

const dateDescription =
  'Date in dd.MM.yyyy format (Czech style). Omit for today. Use this to log something the user ate on a previous day.';

/** Tool results are text; JSON keeps them unambiguous for the model. */
function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

/**
 * Wraps a tool handler so every call lands in the container log with its
 * arguments and outcome, and every throw becomes an in-band tool error.
 * Without this, a failing tool is invisible from the server side.
 */
function guard<Args>(name: string, fn: (args: Args) => Promise<ReturnType<typeof json>>) {
  return async (args: Args) => {
    try {
      const result = await fn(args);
      console.log(`[tool] ${name} ${JSON.stringify(args)} -> ok`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tool] ${name} ${JSON.stringify(args)} -> ${message}`);
      return failure(error);
    }
  };
}

export function registerTools(server: McpServer, kt: KtClient): void {
  server.registerTool(
    'search_food',
    {
      title: 'Search foods',
      description:
        'Find foods in the kaloricketabulky.cz database by name or barcode. Call this first whenever the user mentions eating something, to get the food id the other tools need. ' +
        'The database is Czech, so prefer Czech search terms ("vejce" rather than "egg") for the best matches. ' +
        'A 13-digit EAN barcode also works and resolves to the exact product.',
      inputSchema: {
        query: z.string().min(1).describe('Food name (Czech works best) or a 13-digit EAN barcode.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results to return. Defaults to 10.'),
      },
    },
    guard('search_food', async ({ query, limit }) => {
      const hits = await kt.search(query, limit ?? 10);
      if (hits.length === 0) {
        return json({ results: [], hint: 'No matches. Try a different or more general Czech term.' });
      }
      return json({ results: hits });
    }),
  );

  server.registerTool(
    'get_food_portions',
    {
      title: 'Get portion units for a food',
      description:
        'List the portion units a food supports (for example "kus (55 g)", "velký kus (60 g)") along with its default portion. ' +
        'Call this after search_food when the user gave a count rather than a weight ("3 eggs", "2 slices"), so you can log natural portions instead of guessing grams.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
      },
    },
    guard('get_food_portions', async ({ food_id }) => {
      const detail = await kt.getFoodDetail(food_id);
      return json({
        id: detail.id,
        title: detail.title,
        default: { amount: detail.defaultAmount, unit_id: detail.defaultUnitId },
        units: detail.units,
        grams_unit_id: GRAM_UNIT,
        note: `Use grams_unit_id (${GRAM_UNIT}) with an amount in grams when the user gave a weight.`,
      });
    }),
  );

  server.registerTool(
    'get_food_nutrition',
    {
      title: 'Get nutrition for a quantity',
      description:
        'Calculate calories and macros for a specific quantity of a food, without logging anything. ' +
        'Use this when the user asks what something contains, or to confirm a portion before logging it. The site does the scaling, so the numbers match its own diary exactly.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
        amount: z.number().positive().describe('How many units. With the grams unit this is a weight in grams.'),
        unit_id: z
          .string()
          .optional()
          .describe(`Unit id from get_food_portions. Omit to use grams (${GRAM_UNIT}).`),
      },
    },
    guard('get_food_nutrition', async ({ food_id, amount, unit_id }) => {
      return json(await kt.getNutrition(food_id, amount, unit_id ?? GRAM_UNIT));
    }),
  );

  server.registerTool(
    'log_food',
    {
      title: 'Log food to the diary',
      description:
        'Write an eating record into the user\'s kaloricketabulky.cz diary. This modifies their real diary, so confirm the food and portion first if there was any ambiguity in what they said. ' +
        'Returns the nutrition that was logged.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
        amount: z.number().positive().describe('How many units. With the grams unit this is a weight in grams.'),
        unit_id: z
          .string()
          .optional()
          .describe(`Unit id from get_food_portions. Omit to use grams (${GRAM_UNIT}).`),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_food', async ({ food_id, amount, unit_id, meal, date }) => {
      const unit = unit_id ?? GRAM_UNIT;
      await kt.logFood({ foodId: food_id, amount, unitId: unit, meal, date });
      // The write has landed; a failed read-back must not become a tool error,
      // or the model retries and logs the food twice.
      const nutrition = await kt.getNutrition(food_id, amount, unit).catch(() => null);
      return json({
        logged: true,
        meal: MEALS[meal],
        date: date ?? todayCzech(),
        amount,
        nutrition,
      });
    }),
  );

  server.registerTool(
    'create_meal',
    {
      title: 'Create a saved recipe',
      description:
        'Save a recipe (the site calls it a "meal") built from existing foods, so it can be logged later in one step instead of ingredient by ingredient. ' +
        'Use this when the user describes something they cook regularly — a smoothie, a bread, a standard breakfast. ' +
        'Look each ingredient up with search_food first to get its id. ' +
        'IMPORTANT: `amount` counts units, not grams. Omit `unit_id` and `amount` means grams for solids and millilitres for liquids, which is what recipes are normally written in. ' +
        'If you do pass a unit_id from get_food_portions, then 2 with "porce (250 ml)" means 500 ml, not 2 ml.',
      inputSchema: {
        title: z.string().min(1).describe('Name for the recipe, e.g. "Ranní smoothie".'),
        ingredients: z
          .array(
            z.object({
              food_id: z.string().min(1).describe('Food id from search_food.'),
              amount: z.number().positive().describe('Number of units. With no unit_id this is grams or millilitres.'),
              unit_id: z
                .string()
                .optional()
                .describe('Optional unit id from get_food_portions. Omit for grams/millilitres.'),
            }),
          )
          .min(1)
          .describe('The ingredients, each with a quantity.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('create_meal', async ({ title, ingredients }) => {
      const id = await kt.createMeal({
        title,
        ingredients: ingredients.map(i => ({ foodId: i.food_id, amount: i.amount, unitId: i.unit_id })),
      });
      // The recipe exists now; the read-back is best-effort decoration only.
      const created = (await kt.listMeals().catch(() => [])).find(m => m.id === id);
      return json({
        created: true,
        meal_id: id,
        title,
        total_energy: created && created.energy !== null ? `${created.energy} ${created.energyUnit}` : null,
        note: 'Energy is for the whole recipe. Log it with log_meal.',
      });
    }),
  );

  server.registerTool(
    'list_my_meals',
    {
      title: 'List saved recipes',
      description:
        "List the user's own saved recipes with their ids and total energy. Call this before log_meal to find the right recipe id, or when the user asks what recipes they have saved.",
      inputSchema: {},
    },
    guard('list_my_meals', async () => {
      return json({ meals: await kt.listMeals() });
    }),
  );

  server.registerTool(
    'log_meal',
    {
      title: 'Log a saved recipe to the diary',
      description:
        "Log one of the user's saved recipes into their diary as a single entry. Find the recipe id with list_my_meals first. This writes to their real diary. " +
        'The whole recipe is always logged — the site provides no way to log a fraction of one. If the user ate only part of a recipe, log the individual ingredients with log_food instead.',
      inputSchema: {
        meal_id: z.string().min(1).describe('Recipe id from list_my_meals.'),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_meal', async ({ meal_id, meal, date }) => {
      await kt.logMeal({ mealId: meal_id, meal, date });
      // Same as log_food: the diary entry exists, so the read-back may not fail the tool.
      const logged = (await kt.listMeals().catch(() => [])).find(m => m.id === meal_id);
      return json({
        logged: true,
        recipe: logged?.title ?? meal_id,
        energy: logged && logged.energy !== null ? `${logged.energy} ${logged.energyUnit}` : null,
        meal: MEALS[meal],
        date: date ?? todayCzech(),
      });
    }),
  );

  server.registerTool(
    'delete_meal',
    {
      title: 'Delete a saved recipe',
      description:
        'Permanently delete one of the user\'s saved recipes. This cannot be undone, so confirm which recipe they mean before calling it. ' +
        'It removes the recipe only — diary entries already logged from it are untouched.',
      inputSchema: {
        meal_id: z.string().min(1).describe('Recipe id from list_my_meals.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_meal', async ({ meal_id }) => {
      const before = (await kt.listMeals()).find(m => m.id === meal_id);
      if (!before) return json({ deleted: false, reason: 'No saved recipe with that id.' });
      await kt.deleteMeal(meal_id);
      return json({ deleted: true, title: before.title });
    }),
  );

  server.registerTool(
    'search_activity',
    {
      title: 'Search activities',
      description:
        'Find physical activities in the kaloricketabulky.cz database ("Chůze - 5,0 km/h po rovině", "Běh", "Plavání"). Call this whenever the user mentions exercise, to get the activity id log_activity needs. ' +
        'The database is Czech, so search with Czech terms ("chůze", "běh", "kolo", "posilování"). Pick the entry whose speed or intensity best matches what the user described.',
      inputSchema: {
        query: z.string().min(1).describe('Activity name in Czech.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results to return. Defaults to 10.'),
      },
    },
    guard('search_activity', async ({ query, limit }) => {
      const hits = await kt.searchActivities(query, limit ?? 10);
      if (hits.length === 0) {
        return json({
          results: [],
          hint: 'No matches. Try a more general Czech term, or use log_custom_activity if the user knows the calories burned.',
        });
      }
      return json({ results: hits });
    }),
  );

  server.registerTool(
    'log_activity',
    {
      title: 'Log an activity to the diary',
      description:
        "Write an activity from the database into the user's diary for a given duration. The site calculates the calories burned from the user's own weight, so do not estimate them. " +
        'Find the activity id with search_activity first. This writes to their real diary. ' +
        'If the user already knows the calories (from a watch or a fitness app), use log_custom_activity instead.',
      inputSchema: {
        activity_id: z.string().min(1).describe('Activity id from search_activity.'),
        minutes: z.number().positive().max(1440).describe('Duration in minutes.'),
        date: z.string().optional().describe('Date in dd.MM.yyyy format (Czech style). Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_activity', async ({ activity_id, minutes, date }) => {
      await kt.logActivity({ activityId: activity_id, minutes, date });
      // Logged; as with food, a failed read-back must not turn into a retry.
      const activities = await kt.getDayActivities(date).catch(() => null);
      return json({ logged: true, date: date ?? todayCzech(), minutes, activities_that_day: activities });
    }),
  );

  server.registerTool(
    'log_custom_activity',
    {
      title: 'Log an activity with known calories',
      description:
        "Write an activity with a calorie figure the user supplies, typically from a sports watch or fitness app (\"Garmin says I burned 450 kcal on a 50-minute run\"). " +
        'Use log_activity instead when the user did not give a calorie figure. This writes to their real diary.',
      inputSchema: {
        title: z.string().min(1).describe('Short name for the activity, e.g. "Běh podle hodinek".'),
        energy_kcal: z.number().positive().max(10000).describe('Total calories burned, in kcal.'),
        minutes: z.number().positive().max(1440).describe('Duration in minutes.'),
        date: z.string().optional().describe('Date in dd.MM.yyyy format (Czech style). Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_custom_activity', async ({ title, energy_kcal, minutes, date }) => {
      await kt.logCustomActivity({ title, energyKcal: energy_kcal, minutes, date });
      const activities = await kt.getDayActivities(date).catch(() => null);
      return json({ logged: true, date: date ?? todayCzech(), activities_that_day: activities });
    }),
  );

  server.registerTool(
    'log_weight',
    {
      title: 'Log body weight',
      description:
        "Record the user's body weight for a day. The site keeps one weight per day, so logging again for the same date replaces that day's value. " +
        'The weight also drives how many calories the site credits for activities, so keeping it current matters.',
      inputSchema: {
        weight_kg: z.number().min(20).max(400).describe('Body weight in kilograms, e.g. 82.4.'),
        date: z.string().optional().describe('Date in dd.MM.yyyy format (Czech style). Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('log_weight', async ({ weight_kg, date }) => {
      await kt.logWeight({ kg: weight_kg, date });
      return json({ logged: true, weight_kg, date: date ?? todayCzech() });
    }),
  );

  server.registerTool(
    'get_day_summary',
    {
      title: 'Get a day summary',
      description:
        'Read back totals from the diary for one day — use this when the user asks what they have eaten, how many calories they have left, or how a day went.',
      inputSchema: {
        date: z.string().optional().describe(dateDescription),
      },
    },
    guard('get_day_summary', async ({ date }) => {
      return json({ date: date ?? todayCzech(), summary: await kt.getDaySummary(date) });
    }),
  );
}
