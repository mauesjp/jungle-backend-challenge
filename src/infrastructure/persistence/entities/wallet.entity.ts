import {Entity, PrimaryKey, Property, Unique, Check} from "@mikro-orm/decorators/legacy";
import {randomUUID} from 'node:crypto';


@Entity({tableName: 'wallets'})
@Unique({properties: ['playerId', 'currency']})
@Check({expression: 'balance >= 0'})
export class WalletEntity {

    @PrimaryKey({type: 'uuid'})
    id: string = randomUUID();

    @Property({type: 'string'})
    playerId: string;

    @Property({type: 'string', length: 3})
    currency!: string;

    @Property({type: 'decimal', precision: 20, scale: 2})
    balance!: string;

    @Property({ type: 'integer', version: true })
    version!: number;

    @Property({type: 'datetime'})
    createdAt: Date = new Date();

    @Property({type: 'datetime', onUpdate: () => new Date()})
    updatedAt: Date = new Date();
};