DROP INDEX "rul_predictions_unit_cycle_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "rul_predictions_unit_cycle_key" ON "rul_predictions" USING btree ("unit_id","cycle");