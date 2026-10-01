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
import { baseUnitOf, type DayTotals, KtClient, KtError, MEALS, type MealId, shiftCzechDate, todayCzech } from '../kt/client.js';

const MEAL_IDS = Object.keys(MEALS) as [MealId, ...MealId[]];

const mealDescription = `Which meal slot to file the entry under: ${Object.entries(MEALS)
  .map(([id, name]) => `${id} = ${name}`)
  .join(', ')}.`;

const dateDescription =
  'Date in dd.MM.yyyy format (Czech style). Omit for today. Use this to log something the user ate on a previous day.';

const unitDescription =
  "Unit id from get_food_portions. Omit to use the food's base unit: grams for solid food, millilitres for drinks.";

/**
 * Picks the unit for a food quantity. Without an explicit unit this is the
 * food's own base unit, never a hard-coded gram: drinks are measured in
 * millilitres and have no gram unit at all, so the site rejects a gram entry
 * for them ("Potravinu se nepodařilo zapsat"). An explicit unit is checked
 * against the food's list so a wrong one fails with the valid choices.
 */
async function resolveUnit(kt: KtClient, foodId: string, unitId?: string): Promise<string> {
  const detail = await kt.getFoodDetail(foodId);
  const unit = unitId ?? baseUnitOf(detail.units);
  if (!detail.units.some(u => u.id === unit)) {
    throw new KtError(
      `${detail.title}: unit ${unit} is not valid for this food. Available: ` +
        detail.units.map(u => `${u.title} (${u.id})`).join(', '),
    );
  }
  return unit;
}

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
        base_unit_id: baseUnitOf(detail.units),
        note: 'Use base_unit_id with an amount in grams (solid food) or millilitres (drinks) when the user gave a weight or volume.',
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
        amount: z.number().positive().describe('How many units. With the base unit this is grams for solid food or millilitres for drinks.'),
        unit_id: z
          .string()
          .optional()
          .describe(unitDescription),
      },
    },
    guard('get_food_nutrition', async ({ food_id, amount, unit_id }) => {
      return json(await kt.getNutrition(food_id, amount, await resolveUnit(kt, food_id, unit_id)));
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
        amount: z.number().positive().describe('How many units. With the base unit this is grams for solid food or millilitres for drinks.'),
        unit_id: z
          .string()
          .optional()
          .describe(unitDescription),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_food', async ({ food_id, amount, unit_id, meal, date }) => {
      const unit = await resolveUnit(kt, food_id, unit_id);
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
    'get_day_entries',
    {
      title: 'List diary entries for a day',
      description:
        "List every entry in the user's diary for one day: foods and recipes grouped by meal, activities, and notes, each with its entry id. Foods also carry their amount, calories, the database food_id and whether the amount can be edited. " +
        'Use this when the user asks what exactly they logged, to find an entry to edit, move or delete, and before logging to avoid duplicating something already there. ' +
        'For totals and remaining calories use get_day_summary instead.',
      inputSchema: {
        date: z.string().optional().describe('Date in dd.MM.yyyy format (Czech style). Omit for today.'),
      },
    },
    guard('get_day_entries', async ({ date }) => {
      const { foods, activities, notes } = await kt.getDayEntries(date);
      return json({
        date: date ?? todayCzech(),
        foods: foods.map(f => ({ ...f, meal: MEALS[f.meal] })),
        activities,
        notes: notes.map(n => ({ ...n, meal: n.meal === null ? 'whole day' : MEALS[n.meal] })),
      });
    }),
  );

  server.registerTool(
    'delete_diary_entry',
    {
      title: 'Delete a diary entry',
      description:
        "Remove one food, recipe, activity or note entry from the user's diary, e.g. to fix a mistake or a duplicate. Get the entry id from get_day_entries for the same date. " +
        'This cannot be undone, so unless the user named the exact entry, confirm which one they mean before calling it. Only one entry per call.',
      inputSchema: {
        entry_id: z.string().min(1).describe('Entry id from get_day_entries (not a food or activity id from search).'),
        date: z.string().optional().describe('Date the entry is on, in dd.MM.yyyy format. Omit for today.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_diary_entry', async ({ entry_id, date }) => {
      // Look the id up first: it tells us which delete route applies, and it
      // stops a food id from search, or an entry on another day, from being
      // passed straight to a delete.
      const { foods, activities, notes } = await kt.getDayEntries(date);
      const food = foods.find(f => f.id === entry_id);
      const activity = activities.find(a => a.id === entry_id);
      const note = notes.find(n => n.id === entry_id);
      if (food) {
        await kt.deleteFoodEntry(entry_id);
        return json({ deleted: true, kind: 'food', title: food.title, amount: food.amount, meal: MEALS[food.meal], date: date ?? todayCzech() });
      }
      if (activity) {
        await kt.deleteActivityEntry(entry_id);
        return json({ deleted: true, kind: 'activity', title: activity.title, duration: activity.duration, date: date ?? todayCzech() });
      }
      if (note) {
        await kt.deleteNote(entry_id);
        return json({ deleted: true, kind: 'note', text: note.text, date: date ?? todayCzech() });
      }
      return json({ deleted: false, reason: `No diary entry with that id on ${date ?? todayCzech()}. Call get_day_entries for the right date.` });
    }),
  );

  server.registerTool(
    'edit_diary_entry',
    {
      title: 'Edit a diary entry',
      description:
        "Change an entry already in the user's diary instead of deleting and re-logging it: the amount or unit of a food, the duration of an activity, or which meal a food is filed under. " +
        'Get the entry id from get_day_entries for the same date. Only database foods (editable: true) can change amount or meal; recipes and own foods cannot, so delete and re-log those instead.',
      inputSchema: {
        entry_id: z.string().min(1).describe('Entry id from get_day_entries.'),
        date: z.string().optional().describe('Date the entry is on, in dd.MM.yyyy format. Omit for today.'),
        amount: z.number().positive().optional().describe('Food only: new number of units (grams or millilitres with the base unit).'),
        unit_id: z.string().optional().describe('Food only: new unit id from get_food_portions. Omit to keep the current unit.'),
        minutes: z.number().positive().max(1440).optional().describe('Activity only: new duration in minutes.'),
        meal: z.enum(MEAL_IDS).optional().describe(`Food only: move the entry to this meal. ${mealDescription}`),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('edit_diary_entry', async ({ entry_id, date, amount, unit_id, minutes, meal }) => {
      const day = date ?? todayCzech();
      const { foods, activities } = await kt.getDayEntries(day);
      const food = foods.find(f => f.id === entry_id);
      const activity = activities.find(a => a.id === entry_id);

      if (activity) {
        if (minutes === undefined) return json({ edited: false, reason: 'For an activity, pass minutes.' });
        await kt.editActivityDuration(entry_id, minutes);
        const after = (await kt.getDayActivities(day).catch(() => [])).find(a => a.id === entry_id);
        return json({ edited: true, kind: 'activity', title: activity.title, now: after ?? null });
      }
      if (!food) {
        return json({ edited: false, reason: `No food or activity entry with that id on ${day}. Call get_day_entries for the right date.` });
      }
      if (amount === undefined && unit_id === undefined && meal === undefined) {
        return json({ edited: false, reason: 'Pass amount, unit_id or meal to change.' });
      }
      if (!food.editable) {
        return json({ edited: false, reason: `${food.title} is a recipe or own food; the site cannot edit it. Delete it and log it again.` });
      }

      if (amount !== undefined || unit_id !== undefined) {
        await kt.editFoodAmount(entry_id, amount, unit_id);
      }
      if (meal !== undefined && meal !== food.meal) {
        // Moving is copy + delete, so the entry gets a new id.
        await kt.moveFoodEntry(entry_id, day, meal);
      }
      const after = await kt.getDayEntries(day).catch(() => null);
      const moved = meal !== undefined && meal !== food.meal;
      const now = after?.foods.find(f => (moved ? f.meal === meal && f.foodId === food.foodId : f.id === entry_id));
      return json({
        edited: true,
        kind: 'food',
        title: food.title,
        now: now ? { ...now, meal: MEALS[now.meal] } : null,
        note: moved ? 'Moving gives the entry a new id.' : undefined,
      });
    }),
  );

  server.registerTool(
    'copy_meal',
    {
      title: 'Copy a meal to another day or slot',
      description:
        'Copy the food from one meal of one day into a meal of another day (or another meal of the same day), e.g. "log the same breakfast as yesterday". ' +
        'Everything in that meal is copied unless food_ids narrows it to specific database foods (food_id from get_day_entries). This writes to the real diary. ' +
        'To repeat a whole day, call it once per meal, or save the day as a template.',
      inputSchema: {
        from_date: z.string().describe('Date to copy from, dd.MM.yyyy.'),
        from_meal: z.enum(MEAL_IDS).describe(`Meal to copy from. ${mealDescription}`),
        to_date: z.string().optional().describe('Date to copy to, dd.MM.yyyy. Omit for today.'),
        to_meal: z.enum(MEAL_IDS).optional().describe('Meal to copy into. Omit to use the same meal as from_meal.'),
        food_ids: z.array(z.string().min(1)).min(1).optional().describe('Only copy entries of these database foods (food_id from get_day_entries).'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('copy_meal', async ({ from_date, from_meal, to_date, to_meal, food_ids }) => {
      const toDate = to_date ?? todayCzech();
      const toMeal = to_meal ?? from_meal;
      const copied = await kt.copyMealSlot({ fromDate: from_date, fromMeal: from_meal, toDate, toMeal, foodIds: food_ids });
      return json({ copied, from: `${MEALS[from_meal]} ${from_date}`, to: `${MEALS[toMeal]} ${toDate}` });
    }),
  );

  server.registerTool(
    'log_own_food',
    {
      title: 'Log a food with your own nutrition values',
      description:
        "Log something that is not in the database, with nutrition the user supplies, typically read off a product label or a restaurant's menu. " +
        'Values are for the whole portion eaten, not per 100 g, so scale them first when the label is per 100 g. ' +
        'Search the database with search_food first; use this only when nothing there matches. This writes to the real diary.',
      inputSchema: {
        title: z.string().min(1).describe('Name of the food, e.g. "Proteinová tyčinka XY".'),
        energy_kcal: z.number().positive().max(10000).describe('Energy of the portion eaten, in kcal.'),
        protein: z.number().min(0).optional().describe('Protein in grams, for the portion eaten.'),
        carbs: z.number().min(0).optional().describe('Carbohydrates in grams, for the portion eaten.'),
        fat: z.number().min(0).optional().describe('Fat in grams, for the portion eaten.'),
        sugar: z.number().min(0).optional().describe('Sugars in grams, for the portion eaten.'),
        fibre: z.number().min(0).optional().describe('Fibre in grams, for the portion eaten.'),
        saturated_fat: z.number().min(0).optional().describe('Saturated fat in grams, for the portion eaten.'),
        salt: z.number().min(0).optional().describe('Salt in grams, for the portion eaten.'),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_own_food', async ({ title, energy_kcal, protein, carbs, fat, sugar, fibre, saturated_fat, salt, meal, date }) => {
      await kt.logOwnFood({
        title,
        values: { energyKcal: energy_kcal, protein, carbs, fat, sugar, fibre, saturatedFat: saturated_fat, salt },
        meal,
        date,
      });
      return json({ logged: true, title, energy_kcal, meal: MEALS[meal], date: date ?? todayCzech() });
    }),
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add a note to the diary',
      description:
        'Add a free-text note to a day ("slept badly", "ate out at a wedding"), either to the whole day or to one meal. Notes show in the diary next to the food. ' +
        'Delete one with delete_diary_entry, using the id from get_day_entries.',
      inputSchema: {
        text: z.string().min(1).max(2000).describe('The note text.'),
        meal: z.enum(MEAL_IDS).optional().describe(`Attach the note to this meal. Omit for a note on the whole day. ${mealDescription}`),
        date: z.string().optional().describe('Date in dd.MM.yyyy format. Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('add_note', async ({ text, meal, date }) => {
      await kt.addNote({ text, meal, date });
      return json({ added: true, text, attached_to: meal === undefined ? 'whole day' : MEALS[meal], date: date ?? todayCzech() });
    }),
  );

  server.registerTool(
    'get_usual_items',
    {
      title: "List the user's favourite and most used items",
      description:
        "List the user's favourite foods and activities and the ones they use most, with the ids log_food and log_activity take. " +
        'Check this first when the user refers to something habitual ("my usual coffee", "the bread I always have"), before a general search_food.',
      inputSchema: {},
    },
    guard('get_usual_items', async () => {
      const items = await kt.getUsualItems();
      return json({
        favourite_foods: items.favouriteFoods,
        most_used_foods: items.commonFoods,
        favourite_activities: items.favouriteActivities,
        most_used_activities: items.commonActivities,
      });
    }),
  );

  server.registerTool(
    'set_favorite',
    {
      title: 'Add or remove a favourite',
      description:
        "Mark a database food or activity as one of the user's favourites, or remove it, e.g. \"remember this yoghurt as a favourite\". Favourites are listed by get_usual_items and in the site's own app.",
      inputSchema: {
        kind: z.enum(['food', 'activity']).describe('Whether the id is a food or an activity.'),
        id: z.string().min(1).describe('Food id from search_food, or activity id from search_activity.'),
        favorite: z.boolean().describe('true to add to favourites, false to remove.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('set_favorite', async ({ kind, id, favorite }) => {
      await kt.setFavourite(kind, id, favorite);
      return json({ done: true, kind, id, favorite });
    }),
  );

  server.registerTool(
    'get_period_overview',
    {
      title: 'Overview of several days',
      description:
        'Totals for a run of days, one row per day (energy eaten, target, burned by activity, protein, carbs, fat, litres drunk, and every nutrient the user tracks) plus averages over the logged days. ' +
        "The averages include each tracked nutrient's daily goal (taken from the last day of the period) and how the average compares to it. " +
        'Use this for "how was my week", "average protein this month", "am I hitting my fibre goal" and similar questions. Days with nothing logged are listed but left out of the averages.',
      inputSchema: {
        end_date: z.string().optional().describe('Last day of the period, dd.MM.yyyy. Omit for today.'),
        days: z.number().int().min(1).max(31).optional().describe('Number of days ending with end_date. Defaults to 7.'),
      },
    },
    guard('get_period_overview', async ({ end_date, days }) => {
      const end = end_date ?? todayCzech();
      const count = days ?? 7;
      const rows: DayTotals[] = [];
      // Sequential on purpose: keep the request rate human.
      for (let i = count - 1; i >= 0; i--) rows.push(await kt.getDayTotals(shiftCzechDate(end, -i)));
      const logged = rows.filter(r => (r.energy ?? 0) > 0);
      const avg = (pick: (r: DayTotals) => number | null) =>
        logged.length === 0 ? null : Math.round((logged.reduce((sum, r) => sum + (pick(r) ?? 0), 0) / logged.length) * 10) / 10;
      // Goals can change over a period; the latest day's are the ones the user is working to now.
      const latest = rows[rows.length - 1]?.nutrients ?? [];
      const nutrientAverages = latest.map(n => {
        const average = avg(r => r.nutrients.find(x => x.code === n.code)?.actual ?? null);
        return {
          code: n.code,
          title: n.title,
          unit: n.unit,
          average,
          goal: n.goal,
          percent_of_goal: average === null || !n.goal ? null : Math.round((average / n.goal) * 100),
        };
      });
      return json({
        from: rows[0]?.date,
        to: end,
        // Per-day nutrients as {code: amount}; titles, units and goals are in the averages.
        days: rows.map(({ nutrients, ...r }) => ({
          ...r,
          nutrients: Object.fromEntries(nutrients.map(n => [n.code, n.actual])),
        })),
        logged_days: logged.length,
        averages_over_logged_days: {
          energy: avg(r => r.energy),
          energy_target: avg(r => r.energyTarget),
          energy_burned: avg(r => r.energyBurned),
          protein: avg(r => r.protein),
          carbs: avg(r => r.carbs),
          fat: avg(r => r.fat),
          drink_litres: avg(r => r.drinkLitres),
          nutrients: nutrientAverages,
        },
      });
    }),
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List saved day templates',
      description:
        "List the user's saved day templates (the site's \"Moje jídelníčky\"): whole days of food saved to be written into the diary again. Use the id with apply_template or delete_template.",
      inputSchema: {},
    },
    guard('list_templates', async () => json({ templates: await kt.listTemplates() })),
  );

  server.registerTool(
    'create_template',
    {
      title: 'Save a day as a template',
      description:
        'Save everything logged on one day as a reusable template, e.g. "save today as my standard workday". Optionally include that day\'s activities and notes. ' +
        'Write it back into the diary later with apply_template.',
      inputSchema: {
        title: z.string().min(1).describe('Name for the template, e.g. "Pracovní den".'),
        date: z.string().optional().describe('Day to save, dd.MM.yyyy. Omit for today.'),
        include_activities: z.boolean().optional().describe('Also save the activities. Defaults to false.'),
        include_notes: z.boolean().optional().describe('Also save the notes. Defaults to false.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('create_template', async ({ title, date, include_activities, include_notes }) => {
      await kt.createTemplate({
        title,
        date: date ?? todayCzech(),
        includeActivities: include_activities ?? false,
        includeNotes: include_notes ?? false,
      });
      const created = (await kt.listTemplates().catch(() => [])).filter(t => t.title === title).pop();
      return json({ created: true, title, template_id: created?.id ?? null });
    }),
  );

  server.registerTool(
    'apply_template',
    {
      title: 'Write a template into the diary',
      description:
        'Write a saved day template into the diary on one or more dates. Everything in the template is added to what is already there, so check with get_day_entries first to avoid duplicates. ' +
        'This writes to the real diary, possibly many entries at once, so confirm the dates with the user.',
      inputSchema: {
        template_id: z.string().min(1).describe('Template id from list_templates.'),
        dates: z.array(z.string()).min(1).max(31).describe('Dates to write it to, each dd.MM.yyyy.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('apply_template', async ({ template_id, dates }) => {
      await kt.applyTemplate(template_id, dates);
      return json({ written: true, template_id, dates });
    }),
  );

  server.registerTool(
    'delete_template',
    {
      title: 'Delete a saved day template',
      description:
        'Permanently delete one of the user\'s saved day templates. Diary entries already written from it are untouched. Confirm which template they mean first.',
      inputSchema: {
        template_id: z.string().min(1).describe('Template id from list_templates.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_template', async ({ template_id }) => {
      const before = (await kt.listTemplates()).find(t => t.id === template_id);
      if (!before) return json({ deleted: false, reason: 'No saved template with that id.' });
      await kt.deleteTemplate(template_id);
      return json({ deleted: true, title: before.title });
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
        'Read back totals from the diary for one day — use this when the user asks what they have eaten, how many calories they have left, or how a day went. ' +
        'For progress against the daily goals for protein, carbs, fat, fibre and other nutrients, use get_day_progress instead.',
      inputSchema: {
        date: z.string().optional().describe(dateDescription),
      },
    },
    guard('get_day_summary', async ({ date }) => {
      return json({ date: date ?? todayCzech(), summary: await kt.getDaySummary(date) });
    }),
  );

  server.registerTool(
    'get_day_progress',
    {
      title: 'Progress against daily goals',
      description:
        "Compare one day's intake with the user's daily goals set on the site: energy, protein, carbs, fat, fibre, every other nutrient the user tracks (e.g. sugar, salt, saturated fat, calcium), drinks and weight. " +
        'Each nutrient comes with actual, goal, remaining (negative once over the goal) and percent. ' +
        'Use this for "how much protein do I still need today", "am I over on sugar" or when suggesting what to eat next to hit the goals. ' +
        'Goals are read-only here; the user changes them on the site.',
      inputSchema: {
        date: z.string().optional().describe('Date in dd.MM.yyyy format (Czech style). Omit for today.'),
      },
    },
    guard('get_day_progress', async ({ date }) => {
      const t = await kt.getDayTotals(date ?? todayCzech());
      // Two decimals: one would round 2.98 l of drinks to 3.
      const remaining = (goal: number | null, actual: number | null) =>
        goal === null || actual === null ? null : Math.round((goal - actual) * 100) / 100;
      return json({
        date: t.date,
        energy: {
          unit: t.energyUnit,
          eaten: t.energy,
          burned: t.energyBurned,
          goal: t.energyTarget,
          remaining: remaining(t.energyTarget, t.energy),
        },
        nutrients: t.nutrients,
        drinks: { unit: 'l', actual: t.drinkLitres, goal: t.drinkTargetLitres, remaining: remaining(t.drinkTargetLitres, t.drinkLitres) },
        weight: { unit: 'kg', current: t.weightKg, goal: t.weightTargetKg },
      });
    }),
  );
}
