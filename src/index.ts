import type { Request, Response } from "express";
import fetch, { Response as FetchResponse } from "node-fetch";
import "dotenv/config";

const trelloURL = "https://api.trello.com/1/";
const token = process.env.TOKEN;
const key = process.env.KEY;

function callTrelloApi(
  part: string,
  params = new URLSearchParams(),
  method = "GET"
): Promise<FetchResponse> {
  return fetch(trelloURL + part + "?" + params.toString(), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`,
    },
  });
}

// This config object allows som ecustom preprocessing of certain values eg.g swapping keys or adding data
const keyReplacer: {
  [key: string]: (
    value: string,
    listId: string
  ) => Promise<[key: string, value: string]>;
} = {
  description: async (value) => ["desc", value],
  label: async (value, listId) => {
    // we first need the board id
    const { id } = (await callTrelloApi(`lists/${listId}/board`).then((t) =>
      t.json()
    )) as { id: string };
    // then we need to check if a label with that name exists
    const { labels } = (await callTrelloApi(
      `boards/${id}`,
      new URLSearchParams({
        labels: "all",
        label_fields: "name,color",
      })
    ).then((t) => t.json())) as {
      labels: [{ id: string; name: string; color: string }];
    };
    // then we check if any of those labels exist
    const match = labels.find((l) => l.name === value || l.color == value);
    if (match) return ["idLabels", match.id];
    // else we have to create it
    const { id: labelId } = (await callTrelloApi(
      `labels`,
      new URLSearchParams({
        name: value,
        color: "null",
        idBoard: id,
      }),
      "POST"
    ).then((t) => t.json())) as { id: string };
    return ["idLabels", labelId];
  },
};

// This class holds everythind necessary to get the information from the request body
class Card {
  props: { [key: string]: string } = {};

  constructor(body: any) {
    // ig body or fields is null|undefined it will be an empty array, which short circuits the whole operation
    // for all our field only one value is supported
    for (const field of body?.fields ?? []) {
      // we should check a few mor things here first
      this.props[field.label.toLowerCase()] = field.values[0].label;
    }
  }

  get isValid(): boolean {
    return typeof this.props.name == "string";
  }

  async put(listId: string) {
    const params = new URLSearchParams(this.props);
    params.append("idList", listId);
    for (const key of Object.keys(this.props)) {
      if (keyReplacer[key]) {
        const [k, v] = await keyReplacer[key](params.get(key)!, listId);
        params.delete(key);
        params.append(k, v);
      }
    }
    return callTrelloApi("cards", params, "POST");
  }
}

export async function callTrello(req: Request, res: Response) {
  console.log(req.method, req.body, req.query);
  if (req.method !== "POST") {
    res.status(405).json({ error: "Only 'POST' requests are allowed" });
    return;
  }
  const card = new Card(req.body);
  if (card.isValid && typeof req.query.listId == "string") {
    card
      .put(req.query.listId)
      .then((t) => {
        // we propagate backend errors
        res.status(t.status);
        // we chain into a promise call either with text or json data
        return t.ok ? t.json() : t.text();
      })
      // we set the payload as json
      .then((result) => res.json(result))
      // any other erros are server errors
      .catch((error) => {
        res.status(500).json({ error: error.toString() });
      });
  } else {
    // this is because heyflow wants a 200 when init
    if (
      req.body.message.match(/Heyflow Webhook API successfully initialized/)
    ) {
      res.status(201).send();
    } else {
      res.status(400).json({
        error: card.isValid
          ? "The search param listId is not given"
          : "Request body is missing name",
      });
    }
    return;
  }
}
