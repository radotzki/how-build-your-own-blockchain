import { sha256 } from "js-sha256";
import { serialize, deserialize } from "serializer.ts/Serializer";
import BigNumber from "bignumber.js";

import * as fs from "fs";
import * as path from "path";
import deepEqual = require("deep-equal");

import * as uuidv4 from "uuid/v4";
import * as express from "express";
import * as bodyParser from "body-parser";
import { URL } from "url";
import axios from "axios";

import { Set } from "typescript-collections";
import * as parseArgs from "minimist";

const NodeRSA = require('node-rsa');

export type Address = string;

export class TransactionInput {
    constructor(public transaction: Transaction, public outputIdx: number) { }

    get parentOutput() {
        return this.transaction.outputs[this.outputIdx];
    }

    toJson() {
        return {
            transaction: this.transaction.hash(),
            outputIdx: this.outputIdx,
        };
    }
}

export class TransactionOutput {
    constructor(public recipientAddress: string, public amount: number) { }

    toJson() {
        return {
            recipientAddress: this.recipientAddress,
            amount: this.amount,
        };
    }
}

export class Transaction {
    signature: Buffer;

    constructor(public wallet: Wallet, public inputs: TransactionInput[], public outputs: TransactionOutput[]) {
        if (wallet) {
            this.signature = wallet.sign(JSON.stringify(this.toJson()));
        }
    }

    toJson(): Object {
        return {
            inputs: this.inputs.map(i => i.toJson()),
            outputs: this.outputs.map(o => o.toJson()),
        }
    }

    hash() {
        return sha256(JSON.stringify(this.toJson()));
    }

    public static verify(transaction: Transaction) {
        // Check that all of the inputs of the transaction belong to the same wallet
        const sameWallet = transaction.inputs.every(txin =>
            txin.parentOutput.recipientAddress === transaction.inputs[0].parentOutput.recipientAddress
        );

        // Check that the transaction is signed by the owner of the wallet
        const correctSignature = verifySignature(transaction.wallet.address, JSON.stringify(transaction.toJson()), transaction.signature);

        // Check that the sender have enough funds for this transaction
        const totalIn = transaction.inputs.reduce((sum, txin) => txin.parentOutput.amount + sum, 0);
        const totalOut = transaction.outputs.reduce((sum, txout) => txout.amount + sum, 0);
        const funds = totalOut <= totalIn;

        return sameWallet && correctSignature && funds;
    }
}

export class GenesisTransaction extends Transaction {
    constructor(recipientAddress: string, amount: number) {
        super(null, [], [new TransactionOutput(recipientAddress, amount)]);
        this.signature = Buffer.from('genesis', 'utf8');
    }
}

export class Block {
    public static readonly DIFFICULTY = 4;
    public static readonly TARGET = 2 ** (256 - Block.DIFFICULTY);
    public static readonly MINING_REWARD = 25;

    nonce: number;
    hash: string;
    blockNumber: number;
    validTransaction: boolean;
    blockDifficulty = Block.TARGET;

    constructor(
        public transactions: Transaction[],
        public ancestor: Block,
        public minerAddress: string,
    ) {
        this.transactions = [new GenesisTransaction(minerAddress, Block.MINING_REWARD), ...transactions];

        if (ancestor) {
            this.blockNumber = ancestor.blockNumber + 1;
        } else {
            this.blockNumber = 0;
        }

        this.validTransaction = transactions.every(Transaction.verify);

        if (this.validTransaction) {
            this.mine();
        }
    }

    toJson() {
        return {
            nonce: this.nonce,
            hash: this.hash,
            blockNumber: this.blockNumber,
            ancestor: this.ancestor.hash,
            transactions: this.transactions.map(t => t.toJson()),
            genesisBlock: false,
        }
    }

    mine() {
        console.log('Mining block #' + this.blockNumber);
        this.nonce = 0;

        while (true) {
            const pow = this.sha256();

            if (this.isPoWValid(pow)) {
                this.hash = pow;
                break;
            }

            this.nonce++;
        }
    }

    // Validates PoW.
    public isPoWValid(pow: string): boolean {
        try {
            if (!pow.startsWith("0x")) {
                pow = `0x${pow}`;
            }

            return new BigNumber(pow).lessThanOrEqualTo(this.blockDifficulty.toString());
        } catch {
            return false;
        }
    }

    // Calculates the SHA256 of the entire block, including its transactions.
    public sha256(): string {
        return sha256(JSON.stringify(this.toJson()));
    }
}

export class GenesisBlock extends Block {
    constructor(public minerAddress: string) {
        super([], null, minerAddress);
    }

    toJson() {
        return {
            transactions: [] as Transaction[],
            ancestor: '',
            genesisBlock: true,
            nonce: this.nonce,
            hash: this.hash,
            blockNumber: this.blockNumber,
        };
    }
}

export class Node {
    public id: string;
    public url: URL;

    constructor(id: string, url: URL) {
        this.id = id;
        this.url = url;
    }

    public toString(): string {
        return `${this.id}:${this.url}`;
    }
}

export class Wallet {
    private privateKey: string;
    public address: string;

    constructor() {
        const key = new NodeRSA({ b: 512 });
        this.address = key.exportKey('public-der').toString('hex');
        this.privateKey = key.exportKey('private-der').toString('hex');
    }

    sign(message: string) {
        const privateKeyBuff = Buffer.from(this.privateKey, 'hex');
        const key = new NodeRSA(privateKeyBuff, 'private-der');
        const messageBuff = Buffer.from(message, 'utf8');
        return key.sign(messageBuff);
    }
}

function verifySignature(walletAddress: string, message: string, signature: Buffer) {
    const messageBuff = Buffer.from(message, 'utf8');
    const addressBuff = Buffer.from(walletAddress, 'hex');
    const key = new NodeRSA(addressBuff, 'public-der');
    return key.verify(messageBuff, signature);
}

export class Blockchain {
    public static readonly SATOSHI_NAKAMOTO = '123456';
    public static readonly GENESIS_BLOCK = new GenesisBlock(Blockchain.SATOSHI_NAKAMOTO);

    public static readonly MINING_SENDER = "<COINBASE>";
    public static readonly MINING_REWARD = 50;

    public nodeId: string;
    public nodes: Set<Node>;
    public blocks: Array<Block>;
    private _transactionPool: Array<Transaction>;
    private storagePath: string;

    constructor(nodeId: string) {
        this.nodeId = nodeId;
        this.nodes = new Set<Node>();
        this.storagePath = path.resolve(__dirname, "../", `${this.nodeId}.blockchain`);
        this.initTransactionPool();

        // Load the blockchain from the storage.
        this.load();
    }

    private initTransactionPool() {
        try {
            const txpool = fs.readFileSync(this.storagePath + 'txpool', 'utf-8');
            this._transactionPool = deserialize<Transaction[]>(Transaction, JSON.parse(txpool));
        } catch {
            this._transactionPool = [];
        }
    }

    public get transactionPool() {
        return this._transactionPool;
    }

    public addToTransactionPool(tx: Transaction) {
        this._transactionPool.push(tx);
        fs.writeFileSync(this.storagePath + 'txpool', JSON.stringify(serialize(this._transactionPool)), "utf8");
    }

    public clearTransactionPool() {
        this._transactionPool = [];
        fs.writeFileSync(this.storagePath + 'txpool', JSON.stringify(serialize(this._transactionPool)), "utf8");
    }

    // Registers new node.
    public register(node: Node): boolean {
        return this.nodes.add(node);
    }

    // Saves the blockchain to the disk.
    private save() {
        fs.writeFileSync(this.storagePath, JSON.stringify(serialize(this.blocks), undefined, 2), "utf8");
    }

    // Loads the blockchain from the disk.
    private load() {
        try {
            this.blocks = deserialize<Block[]>(Block, JSON.parse(fs.readFileSync(this.storagePath, "utf8")));
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }

            this.blocks = [Blockchain.GENESIS_BLOCK];
        } finally {
            this.verify();
        }
    }

    // Verifies the blockchain.
    public static verify(blocks: Array<Block>): boolean {
        try {
            // The blockchain can't be empty. It should always contain at least the genesis block.
            if (blocks.length === 0) {
                throw new Error("Blockchain can't be empty!");
            }

            // The first block has to be the genesis block.
            if (!deepEqual(blocks[0], Blockchain.GENESIS_BLOCK)) {
                throw new Error("Invalid first block!");
            }

            // Verify the chain itself.
            for (let i = 1; i < blocks.length; ++i) {
                const current = blocks[i];

                // Verify block number.
                if (current.blockNumber !== i) {
                    throw new Error(`Invalid block number ${current.blockNumber} for block #${i}!`);
                }

                // Verify that the current blocks properly points to the previous block.
                const previous = blocks[i - 1];
                if (current.ancestor.hash !== previous.sha256()) {
                    throw new Error(`Invalid previous block hash for block #${i}!`);
                }

                // Verify the difficutly of the PoW.
                if (!current.isPoWValid(current.sha256())) {
                    throw new Error(`Invalid previous block hash's difficutly for block #${i}!`);
                }
            }

            return true;
        } catch (err) {
            console.error(err);
            return false;
        }
    }

    // Verifies the blockchain.
    private verify() {
        // The blockchain can't be empty. It should always contain at least the genesis block.
        if (!Blockchain.verify(this.blocks)) {
            throw new Error("Invalid blockchain!");
        }
    }

    // Receives candidate blockchains, verifies them, and if a longer and valid alternative is found - uses it to replace
    // our own.
    public consensus(blockchains: Array<Array<Block>>): boolean {
        // Iterate over the proposed candidates and find the longest, valid, candidate.
        let maxLength: number = 0;
        let bestCandidateIndex: number = -1;

        for (let i = 0; i < blockchains.length; ++i) {
            const candidate = blockchains[i];

            // Don't bother validating blockchains shorther than the best candidate so far.
            if (candidate.length <= maxLength) {
                continue;
            }

            // Found a good candidate?
            if (Blockchain.verify(candidate)) {
                maxLength = candidate.length;
                bestCandidateIndex = i;
            }
        }

        // Compare the candidate and consider to use it.
        if (bestCandidateIndex !== -1 && (maxLength > this.blocks.length || !Blockchain.verify(this.blocks))) {
            this.blocks = blockchains[bestCandidateIndex];
            this.save();

            return true;
        }

        return false;
    }

    // Submits new transaction
    public submitTransaction(senderWallet: Wallet, recipientAddress: Address, value: number) {
        let txinputs: TransactionInput[] = [];
        this.blocks.forEach(block => {
            block.transactions.forEach(tx => {
                const outputIdx = tx.outputs.findIndex(txout => txout.recipientAddress == senderWallet.address);
                if (outputIdx > -1) {
                    txinputs.push(new TransactionInput(tx, outputIdx));
                }
            });
        });

        const senderBalance = this.computeBalance(senderWallet.address);

        const txOutputs = [
            new TransactionOutput(recipientAddress, value),
            new TransactionOutput(senderWallet.address, Math.abs(senderBalance - value)),
        ];
        this.addToTransactionPool(new Transaction(senderWallet, txinputs, txOutputs));
    }

    // Creates new block on the blockchain.
    public createBlock(minerAddress: string): Block {
        // Mine the transactions in a new block.
        const newBlock = new Block(this.transactionPool, this.getLastBlock(), minerAddress);

        if (!newBlock.validTransaction) {
            console.log('invalid transaction');
            throw 'Invalid transaction';
        }

        // Append the new block to the blockchain.
        this.blocks.push(newBlock);

        // Remove the mined transactions.
        this.clearTransactionPool();

        // Save the blockchain to the storage.
        this.save();

        return newBlock;
    }

    public getLastBlock(): Block {
        return this.blocks[this.blocks.length - 1];
    }

    public static now(): number {
        return Math.round(new Date().getTime() / 1000);
    }

    public computeBalance(walletAddress: string) {
        const transactions: Transaction[] = this.blocks.reduce((all, curr) => [...all, ...curr.transactions], []);
        let balance = 0;

        transactions.forEach(tx => {
            tx.inputs.forEach(txin => {
                if (txin.parentOutput.recipientAddress == walletAddress) {
                    balance -= txin.parentOutput.amount;
                }
            });

            tx.outputs.forEach(txout => {
                if (txout.recipientAddress == walletAddress) {
                    balance += txout.amount;
                }
            });
        });

        return balance;
    }
}

// Web server:
const ARGS = parseArgs(process.argv.slice(2));
const PORT = ARGS.port || 3000;
const app = express();
const nodeId = ARGS.id || uuidv4();
const blockchain = new Blockchain(nodeId);

// Set up bodyParser:
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err.stack);

    res.status(500);
});

// Show all the blocks.
app.get("/blocks", (req: express.Request, res: express.Response) => {
    res.json(serialize(blockchain.blocks));
});

// Show specific block.
app.get("/blocks/:id", (req: express.Request, res: express.Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
        res.json("Invalid parameter!");
        res.status(500);
        return;
    }

    if (id >= blockchain.blocks.length) {
        res.json(`Block #${id} wasn't found!`);
        res.status(404);
        return;
    }

    res.json(serialize(blockchain.blocks[id]));
});

app.post("/blocks/mine", (req: express.Request, res: express.Response) => {
    // Mine the new block.
    const minerAddress = req.body.minerAddress;
    try {
        const newBlock = blockchain.createBlock(minerAddress);
        res.json(`Mined new block #${newBlock.blockNumber}`);
    } catch (err) {
        res.status(400).send(err);
    }

});

// Show all transactions in the transaction pool.
app.get("/transactions", (req: express.Request, res: express.Response) => {
    res.json(serialize(blockchain.transactionPool));
});

app.post("/transactions", (req: express.Request, res: express.Response) => {
    const senderWallet = deserialize<Wallet>(Wallet, req.body.senderWallet);
    const recipientAddress = req.body.recipientAddress;
    const value = Number(req.body.value);

    if (!senderWallet || !recipientAddress || !value) {
        res.json("Invalid parameters!");
        res.status(500);
        return;
    }

    blockchain.submitTransaction(senderWallet, recipientAddress, value);

    res.json(`Transaction from ${senderWallet.address} to ${recipientAddress} was added successfully`);
});

app.get("/nodes", (req: express.Request, res: express.Response) => {
    res.json(serialize(blockchain.nodes.toArray()));
});

app.post("/nodes", (req: express.Request, res: express.Response) => {
    const id = req.body.id;
    const url = new URL(req.body.url);

    if (!id || !url) {
        res.json("Invalid parameters!");
        res.status(500);
        return;
    }

    const node = new Node(id, url);

    if (blockchain.register(node)) {
        res.json(`Registered node: ${node}`);
    } else {
        res.json(`Node ${node} already exists!`);
        res.status(500);
    }
});

app.put("/nodes/consensus", (req: express.Request, res: express.Response) => {
    // Fetch the state of the other nodes.
    const requests = blockchain.nodes.toArray().map(node => axios.get(`${node.url}blocks`));

    if (requests.length === 0) {
        res.json("There are nodes to sync with!");
        res.status(404);

        return;
    }

    axios.all(requests).then(axios.spread((...blockchains) => {
        if (blockchain.consensus(blockchains.map(res => deserialize<Block[]>(Block, res.data)))) {
            res.json(`Node ${nodeId} has reached a consensus on a new state.`);
        } else {
            res.json(`Node ${nodeId} hasn't reached a consensus on the existing state.`);
        }

        res.status(200);
        return;
    })).catch(err => {
        console.log(err);
        res.status(500);
        res.json(err);
        return;
    });

    res.status(500);
});

app.post("/wallet", (req: express.Request, res: express.Response) => {
    const wallet = new Wallet();
    res.json(JSON.stringify(serialize(wallet)));
});

app.get("/balance/:address", (req: express.Request, res: express.Response) => {
    const address = req.params.address;
    const balance = blockchain.computeBalance(address);
    res.json(balance);
});

if (!module.parent) {
    app.listen(PORT);

    console.log(`Web server started on port ${PORT}. Node ID is: ${nodeId}`);
}
