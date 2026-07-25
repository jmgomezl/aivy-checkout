/**
 * One-shot: create the HCS topic that seals Aivy Checkout receipts.
 * Usage: HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=0x… tsx create-hcs-topic.ts
 */
import { Client, PrivateKey, TopicCreateTransaction } from "@hashgraph/sdk";

const opId = process.env.HEDERA_OPERATOR_ID!;
const opKey = process.env.HEDERA_OPERATOR_KEY!;
if (!opId || !opKey) throw new Error("set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY");

const client = Client.forTestnet().setOperator(opId, PrivateKey.fromStringECDSA(opKey));

const tx = await new TopicCreateTransaction()
  .setTopicMemo("Aivy Checkout — cryptographic checkout receipts (ETHGlobal Lisboa)")
  .execute(client);
const receipt = await tx.getReceipt(client);
console.log("HCS_TOPIC_ID=" + receipt.topicId!.toString());
client.close();
