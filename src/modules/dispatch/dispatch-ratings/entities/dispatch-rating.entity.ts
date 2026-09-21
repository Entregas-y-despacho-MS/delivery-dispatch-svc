import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';

@Entity('dispatch_ratings')
export class DispatchRating extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'dispatch_rating_id' })
    id: number;

    // A dispatch has at most one rating.
    @Column({ name: 'dispatch_id', type: 'int', unique: true })
    dispatchId: number;

    @Column({ name: 'score', type: 'smallint' })
    score: number;

    @Column({ name: 'comment', type: 'text', nullable: true })
    comment: string | null;

    @ManyToOne(() => Dispatch)
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;
}
