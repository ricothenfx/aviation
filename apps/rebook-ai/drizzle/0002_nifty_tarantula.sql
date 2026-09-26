CREATE TABLE "inventory_seats" (
	"flight_no" text PRIMARY KEY NOT NULL,
	"seats_left" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decided_at" timestamp with time zone;