import { z } from "zod";

export const task = z.object({
	id: z.number().int(),
	name: z.string(),
	slug: z.string(),
	description: z.string(),
	completed: z.boolean(),
	due_date: z.string().datetime(),
});

export const TaskModel = {
	tableName: "tasks",
	primaryKeys: ["id"],
	schema: task,
	serializer: (obj: object) => {
		return {
			...obj,
			completed: Boolean("completed" in obj && obj.completed),
		};
	},
	serializerObject: task,
};
