// A fake order backend and the three tools the agent can call.
//
// The page runs the tools; the Prompt API only sees their declarations. The SDK's
// instrumentation records each call as an `execute_tool <name>` span, which is what the
// uses_right_tools scorer reads back from the trace.

const ORDERS = {
  A100: {
    category: "electronics",
    days_since_delivery: 12,
    item: "Wireless Headphones",
    price: 89.99,
    status: "delivered",
  },
  A101: {
    arrives_in_days: 2,
    category: "apparel",
    item: "Running Shoes",
    price: 120.0,
    status: "shipped",
  },
  A102: {
    category: "home",
    days_since_delivery: 45,
    item: "Blender",
    price: 59.5,
    status: "delivered",
  },
  A103: {
    category: "apparel",
    days_since_delivery: 70,
    item: "Winter Jacket",
    price: 200.0,
    status: "delivered",
  },
  A104: {
    category: "electronics",
    days_since_delivery: 5,
    item: "Laptop",
    price: 1299.0,
    status: "delivered",
  },
};
const RETURN_WINDOW_DAYS = { apparel: 60, electronics: 30, home: 30 };

const str = (value) => String(value ?? "");

export const TOOLS = [
  {
    description:
      "Look up an order: item, category, price, shipping status and delivery timing.",
    execute({ order_id }) {
      const id = str(order_id).toUpperCase();
      const order = ORDERS[id];
      return order
        ? { order_id: id, ...order }
        : { error: `Order ${order_id} not found` };
    },
    inputSchema: {
      properties: {
        order_id: {
          description: 'The order ID, for example "A100".',
          type: "string",
        },
      },
      required: ["order_id"],
      type: "object",
    },
    name: "get_order_status",
  },
  {
    description:
      "Get the return window (in days after delivery) for a product category: electronics, apparel or home.",
    execute({ category }) {
      const key = str(category).toLowerCase();
      const days = RETURN_WINDOW_DAYS[key];
      return days
        ? { category: key, return_window_days: days }
        : { error: `No return policy for category ${category}` };
    },
    inputSchema: {
      properties: {
        category: {
          description: "electronics, apparel or home",
          type: "string",
        },
      },
      required: ["category"],
      type: "object",
    },
    name: "get_return_policy",
  },
  {
    description:
      "Start a return (creates an RMA). Only call this after confirming the order is delivered and " +
      "inside its return window, and only when the customer asks for it.",
    execute({ order_id }) {
      return {
        rma_id: `RMA-${str(order_id).toUpperCase()}`,
        status: "created",
      };
    },
    inputSchema: {
      properties: {
        order_id: { description: "The order ID to return.", type: "string" },
      },
      required: ["order_id"],
      type: "object",
    },
    name: "start_return",
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** What the session is told about. */
export const TOOL_DECLARATIONS = TOOLS.map(
  ({ name, description, inputSchema }) => ({ description, inputSchema, name })
);
