import{randomUUID} from "node:crypto";
import {Entity, PrimaryKey, Property, Unique} from "@mikro-orm/decorators/legacy";
import {  WagerTransactionKind, WagerTransactionStatus,} from '../../../domain/enums/wager-transaction.enum.js';
import { ManyToOne } from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity.js';

@Entity({tableName: 'wager_transactions'})
@Unique({properties: ['providerId', 'externalTransactionId'],})
@Unique({ properties: ['idempotencyKey'] })
export class WagerTransactionEntity {
    @PrimaryKey({type: 'uuid'})
    id: string = randomUUID();

    @Property({type: 'string', length: 100})
    providerId: string;

    @Property({type: 'string', length: 255})
    externalTransactionId: string;

    @Property({type: 'string', length: 255})
    idempotencyKey: string;

    @Property({type: 'string', length: 64})
    payloadHash: string;

    @ManyToOne(() => WalletEntity, {
    fieldName: 'wallet_id',
    })
    wallet!: WalletEntity;

    @Property({ type: 'string', length: 255 })
    playerId!: string;

    @Property({ type: 'string', length: 255 })
    roundId!: string;

    @Property({ type: 'string', length: 255 })
    gameId!: string;

    @Property({ type: 'string', length: 30 })
    kind!: WagerTransactionKind;

    @Property({ type: 'string', length: 30 })
    status: WagerTransactionStatus = WagerTransactionStatus.Pending;

    @Property({ type: 'decimal', precision: 20, scale: 2 })
    amount!: string;

    @Property({ type: 'string', length: 3 })
    currency!: string;

    @Property({ type: 'uuid', nullable: true })
    referenceTransactionId?: string;

    @Property({ type: 'string', length: 255, nullable: true })
    referenceExternalTransactionId?: string;

    @Property({ type: 'json', nullable: true })
    resultPayload?: Record<string, unknown>;

    @Property({ type: 'datetime' })
    createdAt: Date = new Date();

    @Property({ type: 'datetime', onUpdate: () => new Date() })
    updatedAt: Date = new Date();

    @Property({ type: 'string', length: 100, nullable: true })
    failureCode?: string;

    @Property({ type: 'datetime', nullable: true })
    processedAt?: Date;
}