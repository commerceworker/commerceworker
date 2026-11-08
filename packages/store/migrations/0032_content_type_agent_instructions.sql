-- 0032_content_type_agent_instructions: how an agent should write a content type's entries.
-- Mirrors `contentTypes.agentInstructions` in packages/store/src/schema.ts.
--
-- A nullable column, so the code already deployed never reads or writes it: its upsert names only
-- the columns it knows, so a save from it leaves this as it was. Nothing is backfilled. Plain text,
-- read through the model by Management, Preview and MCP and never by Delivery: the published
-- definition (0030) is built from named columns, and this is not one of them.
ALTER TABLE `content_types` ADD `agent_instructions` text;
